import { v } from "convex/values";
import { httpAction, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { spendAssistantTurn } from "./lib/budget";
import { HELP } from "./messages";

/** The bot's command menu; each command is the same as typing the words after it. */
const COMMANDS: Record<string, { description: string; says: string }> = {
  balance: { description: "What's safe to spend", says: "how much can I spend" },
  bills: { description: "Bills due soon", says: "what bills are due" },
  spending: { description: "Spending this month", says: "how much did I spend this month" },
  reminders: { description: "Your reminders", says: "what reminders do I have" },
  goals: { description: "Savings goals", says: "how are my goals" },
  freeze: { description: "Freeze every agent now", says: "freeze all agents" },
  help: { description: "What I can do", says: "help" },
};

/**
 * Telegram adapter for the same assistant. Linking starts in the app (a one-time code);
 * only the owner's private chat counts; group and forwarded messages never act.
 * Inactive until TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET are set.
 */

type Update = {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number; type: string };
    from?: { id: number; is_bot?: boolean; first_name?: string; username?: string };
    forward_origin?: unknown;
    forward_from?: unknown;
  };
};

export const telegramWebhook = httpAction(async (ctx, req) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || req.headers.get("x-telegram-bot-api-secret-token") !== secret) return new Response("forbidden", { status: 403 });
  const update = (await req.json()) as Update;
  const m = update.message;
  if (!m?.text || m.chat.type !== "private" || m.from?.is_bot) return new Response("ok");
  if (m.forward_origin || m.forward_from) {
    await ctx.runAction(internal.telegram.send, { chatId: String(m.chat.id), text: "I don't act on forwarded messages. Tell me in your own words what you need." });
    return new Response("ok");
  }
  await ctx.runMutation(internal.telegram.inbound, {
    chatId: String(m.chat.id),
    updateId: update.update_id,
    text: m.text.slice(0, 500),
    name: (m.from?.username ? `@${m.from.username}` : m.from?.first_name ?? "").slice(0, 40),
  });
  return new Response("ok");
});

export const inbound = internalMutation({
  args: { chatId: v.string(), updateId: v.number(), text: v.string(), name: v.optional(v.string()) },
  handler: async (ctx, { chatId, updateId, text: said, name }) => {
    let text = said;
    // Telegram redelivers updates it isn't sure we got. Each update id is handled once, ever.
    const key = `telegram:${updateId}`;
    if (await ctx.db.query("inbound").withIndex("by_key", (q) => q.eq("key", key)).unique()) return;
    await ctx.db.insert("inbound", { key, at: Date.now() });

    const start = text.match(/^\/start(?:\s+([A-Z0-9]{6}))?/i);
    if (start) {
      const code = start[1]?.toUpperCase();
      const link = code ? await ctx.db.query("chatLinks").withIndex("by_code", (q) => q.eq("code", code)).unique() : null;
      if (!code) {
        await ctx.scheduler.runAfter(0, internal.telegram.send, {
          chatId,
          text: "Hi! To link this chat to your wallet, open the app, go to Settings → Telegram, tap \"Get a linking code\", then tap \"Open Telegram\". The code is filled in for you.",
        });
        return;
      }
      if (!link || link.channel !== "telegram" || (link.codeExpiresAt ?? 0) < Date.now()) {
        await ctx.scheduler.runAfter(0, internal.telegram.send, { chatId, text: "That code isn't valid any more (codes last 10 minutes and work once). Get a new one in the app: Settings → Telegram." });
        return;
      }
      // One use only: the code is gone the moment a chat claims it.
      const spent = `used-${crypto.getRandomValues(new Uint32Array(1))[0]}`;
      if (link.linkedAt && link.externalId && link.externalId !== chatId) {
        // Moving an account to a different chat needs the owner's yes in the app.
        await ctx.db.patch(link._id, { code: spent, codeExpiresAt: undefined, pendingExternalId: chatId, pendingName: name });
        await ctx.db.insert("activity", { userId: link.userId, kind: "security", title: "A new Telegram chat wants to link", detail: `${name || "Unknown"} · confirm it in Settings`, tone: "warn" });
        await ctx.scheduler.runAfter(0, internal.telegram.send, { chatId, text: "Almost there. Confirm this chat in the app (Settings) to finish linking." });
        return;
      }
      await ctx.db.patch(link._id, { code: spent, codeExpiresAt: undefined, externalId: chatId, linkedAt: Date.now(), pendingExternalId: undefined });
      const user = await ctx.db.get(link.userId);
      await ctx.db.insert("activity", { userId: link.userId, kind: "security", title: "Telegram linked", detail: name || undefined, tone: "good" });
      await ctx.scheduler.runAfter(0, internal.telegram.send, {
        chatId,
        text: `Linked to ${user?.name ?? "your"} account. Ask what you can spend, list bills, or tell me who to pay.`,
      });
      return;
    }
    const link = await ctx.db.query("chatLinks").withIndex("by_external", (q) => q.eq("channel", "telegram").eq("externalId", chatId)).unique();
    if (/^\/help\b/i.test(text)) {
      await ctx.scheduler.runAfter(0, internal.telegram.send, {
        chatId,
        text: `${link?.linkedAt ? HELP : "Link this chat first: in the app, Settings → Telegram → Get a linking code."}\n\n${Object.entries(COMMANDS)
          .map(([c, d]) => `/${c} – ${d.description}`)
          .join("\n")}`,
      });
      return;
    }
    if (!link?.linkedAt) {
      await ctx.scheduler.runAfter(0, internal.telegram.send, { chatId, text: "This chat isn't linked to an account. Get a linking code in the app first." });
      return;
    }
    // "/bills" is the same as typing "what bills are due".
    const command = text.match(/^\/([a-z]+)(?:@\w+)?\s*$/i)?.[1]?.toLowerCase();
    if (command && COMMANDS[command]) text = COMMANDS[command]!.says;
    await ctx.db.insert("messages", { userId: link.userId, role: "user", text, channel: "telegram" });
    const user = await ctx.db.get(link.userId);
    const useModel = user ? await spendAssistantTurn(ctx, user) : false;
    await ctx.scheduler.runAfter(0, internal.assistant.respond, { userId: link.userId, text, channel: "telegram", useModel });
  },
});

export const chatFor = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const links = await ctx.db.query("chatLinks").withIndex("by_user", (q) => q.eq("userId", userId)).take(5);
    return links.find((l) => l.channel === "telegram" && l.linkedAt)?.externalId ?? null;
  },
});

export const send = internalAction({
  args: { chatId: v.optional(v.string()), userId: v.optional(v.id("users")), text: v.string(), approvalUrl: v.optional(v.string()) },
  handler: async (ctx, { chatId, userId, text, approvalUrl }): Promise<{ ok: boolean; reason?: string; retryAfter?: number; unknown: boolean }> => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return { ok: false, reason: "Telegram is not configured", retryAfter: undefined, unknown: false };
    const chat = chatId ?? (userId ? await ctx.runQuery(internal.telegram.chatFor, { userId }) : null);
    if (!chat) {
      console.warn("telegram.send: no linked chat", userId);
      return { ok: false, reason: "no linked chat", retryAfter: undefined, unknown: false };
    }
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        text,
        link_preview_options: { is_disabled: true },
        ...(approvalUrl ? { reply_markup: { inline_keyboard: [[{ text: "Review and approve", url: approvalUrl }]] } } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; parameters?: { retry_after?: number } };
    if (!body.ok) console.error("telegram.send failed", res.status, body.description);
    return { ok: Boolean(body.ok), reason: body.description, retryAfter: res.status === 429 ? (body.parameters?.retry_after ?? 60) : undefined, unknown: res.status >= 500 || (res.ok && body.ok === undefined) };
  },
});

/** Run once after setting the token: npx convex run telegram:setWebhook */
export const setWebhook = internalAction({
  args: {},
  handler: async () => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const site = process.env.CONVEX_SITE_URL;
    if (!token || !secret || !site) throw new Error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET first");
    const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${site}/telegram`, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: true }),
    });
    const commands = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands: Object.entries(COMMANDS).map(([command, d]) => ({ command, description: d.description })) }),
    });
    return { webhook: await res.json(), commands: await commands.json() };
  },
});
