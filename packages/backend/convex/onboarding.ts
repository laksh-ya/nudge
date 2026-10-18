import { v, ConvexError } from "convex/values";
import { changeLimits, revokeAgent } from "./lib/control";
import { policyTask } from "./lib/actions";
import { country as countryInfo, isVaultVersion } from "@agent-wallet/domain";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { currency } from "./schema";
import { JUDGE, requireViewer, viewer } from "./lib/auth";
import { wipeUser } from "./lib/wipe";
import { hit } from "./lib/limits";
import { seal } from "./lib/secrets";
import { isNvidiaKey } from "./lib/nvidia";

const DAY = 86_400_000;
export const STEPS = ["you", "goals", "sources", "history", "review", "assistant", "wallet", "chat", "people", "done"] as const;

function minorOk(n: number) {
  return Number.isSafeInteger(n) && n >= 0 && n <= 1e13;
}

export const state = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return null;
    const [accounts, obligations, wallet, agents, family, link] = await Promise.all([
      ctx.db.query("accounts").withIndex("by_user", (q) => q.eq("userId", user._id)).take(100),
      ctx.db.query("obligations").withIndex("by_user_due", (q) => q.eq("userId", user._id)).take(200),
      ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique(),
      ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50),
      ctx.db.query("family").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50),
      ctx.db.query("chatLinks").withIndex("by_user", (q) => q.eq("userId", user._id)).first(),
    ]);
    return {
      user: {
        name: user.name,
        country: user.country,
        currency: user.currency,
        timezone: user.timezone,
        incomeDay: user.incomeDay,
        priorities: user.priorities ?? [],
        autonomy: user.autonomy === "draft" || !user.autonomy ? "approve" : user.autonomy,
        reminderChannel: user.reminderChannel ?? "app",
        // No quiet hours until the owner asks for them ("" = off).
        quietFrom: user.quietFrom ?? "",
        quietTo: user.quietTo ?? "",
        reminderLeadDays: user.reminderLeadDays ?? 2,
        privateReminders: user.privateReminders ?? false,
        assistantModel: (user.assistantModel ?? "auto") as "auto" | "basic" | "claude-opus-5-5" | "claude-sonnet-5-5" | "claude-haiku-5-5" | "nvidia",
        ownModelKey: user.modelKeyHint ?? null,
        monthlyBudgetMinor: user.monthlyBudgetMinor,
        emergencyMinor: user.emergencyMinor,
        step: user.onboardingStep ?? (user.onboardedAt ? null : "you"),
        onboardedAt: user.onboardedAt,
      },
      counts: {
        accounts: accounts.length,
        withHistory: accounts.filter((a) => a.status === "ok").length,
        suggested: obligations.filter((o) => o.status === "suggested").length,
        confirmed: obligations.filter((o) => o.status === "active").length,
      },
      // Setup links, challenges and the passkey confirmation code never go to the browser (as in wallet.get).
      wallet: wallet ? { ...wallet, enrolToken: undefined, enrolChallenge: undefined, candidate: undefined } : null,
      agents: agents.map((a) => ({ _id: a._id, provider: a.provider, name: a.name, status: a.status })),
      family: family.map((f) => ({ _id: f._id, name: f.name, relation: f.relation, status: f.status })),
      chat: link
        ? {
            code: link.codeExpiresAt && link.codeExpiresAt > Date.now() ? link.code : null,
            linked: Boolean(link.linkedAt),
            channel: link.channel,
            pending: link.pendingExternalId ? (link.pendingName || "A new chat") : null,
          }
        : null,
      // The bot every account links to; the env var overrides it for another deployment.
      bot: process.env.TELEGRAM_BOT_USERNAME ?? "heynudge_bot",
    };
  },
});

export const setStep = mutation({
  args: { step: v.string() },
  handler: async (ctx, { step }) => {
    const user = await requireViewer(ctx);
    if (!(STEPS as readonly string[]).includes(step)) throw new ConvexError("Unknown step");
    await ctx.db.patch(user._id, { onboardingStep: step });
  },
});

export const savePreferences = mutation({
  args: {
    name: v.string(),
    country: v.string(),
    currency,
    timezone: v.string(),
    incomeDay: v.optional(v.number()),
    monthlyBudgetMinor: v.optional(v.number()),
    emergencyMinor: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await requireViewer(ctx);
    const name = args.name.trim().slice(0, 40);
    if (!name) throw new ConvexError("Add your name");
    const c = countryInfo(args.country);
    let nextIncomeAt = user.nextIncomeAt;
    if (args.incomeDay !== undefined) {
      if (!Number.isInteger(args.incomeDay) || args.incomeDay < 1 || args.incomeDay > 31) throw new ConvexError("Pick a day from 1 to 31");
      const now = new Date();
      const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), args.incomeDay, 6));
      if (next.getTime() <= now.getTime()) next.setUTCMonth(next.getUTCMonth() + 1);
      nextIncomeAt = next.getTime();
    }
    for (const n of [args.monthlyBudgetMinor, args.emergencyMinor]) if (n !== undefined && !minorOk(n)) throw new ConvexError("Amount is out of range");
    await ctx.db.patch(user._id, {
      name,
      country: c.code,
      currency: args.currency,
      timezone: args.timezone.slice(0, 60),
      incomeDay: args.incomeDay ?? user.incomeDay,
      nextIncomeAt,
      monthlyBudgetMinor: args.monthlyBudgetMinor ?? user.monthlyBudgetMinor,
      emergencyMinor: args.emergencyMinor ?? user.emergencyMinor,
    });
  },
});

export const savePriorities = mutation({
  args: { priorities: v.array(v.string()) },
  handler: async (ctx, { priorities }) => {
    const user = await requireViewer(ctx);
    await ctx.db.patch(user._id, { priorities: priorities.slice(0, 10).map((p) => p.slice(0, 20)) });
  },
});

const autonomy = v.union(v.literal("draft"), v.literal("approve"), v.literal("limited"));

async function ownAssistant(ctx: MutationCtx, user: Doc<"users">, mode: "draft" | "approve" | "limited", wallet: Doc<"wallets"> | null) {
  const agents = await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50);
  const scopes: Doc<"agents">["scopes"] =
    mode === "draft" ? ["read", "prepare"] : mode === "approve" ? ["read", "prepare", "request"] : ["read", "prepare", "spend", "request"];
  const cap = mode === "limited" ? (wallet?.dailyCeilingMinor ?? 2_000) : 0;
  const per = mode === "limited" ? (wallet?.perPaymentMinor ?? 1_000) : 0;
  const existing = agents.find((a) => a.provider === "own");
  if (existing) {
    // Through the shared path, so a live vault key is re-limited or frozen too.
    await changeLimits(ctx, user, existing, { scopes, dailyCapMinor: cap, perPaymentMinor: per, expiresAt: existing.expiresAt });
  } else {
    await ctx.db.insert("agents", {
      userId: user._id,
      name: "Nudge",
      provider: "own",
      status: "active",
      scopes,
      dailyCapMinor: cap,
      perPaymentMinor: per,
      spentTodayMinor: 0,
      hidesBalances: false,
      connectedAt: Date.now(),
      expiresAt: Date.now() + 365 * DAY,
    });
  }
}

/** Use your own Anthropic API key for the Nudge assistant (app and Telegram). Stored sealed; never shown again. */
export const setModelKey = mutation({
  args: { key: v.optional(v.string()) },
  handler: async (ctx, { key }) => {
    const user = await requireViewer(ctx);
    if (!key) {
      await ctx.db.patch(user._id, { modelKeySealed: undefined, modelKeyHint: undefined });
      await ctx.db.insert("activity", { userId: user._id, kind: "security", title: "Removed your own Claude API key", tone: "neutral" });
      return null;
    }
    const k = key.trim();
    if (!/^sk-ant-[A-Za-z0-9_-]{20,200}$/.test(k) && !isNvidiaKey(k)) throw new ConvexError("Paste an Anthropic key (sk-ant-…) or an NVIDIA key (nvapi-…)");
    await ctx.db.patch(user._id, { modelKeySealed: await seal(k, `model:${user._id}`), modelKeyHint: k.slice(-4) });
    await ctx.db.insert("activity", { userId: user._id, kind: "security", title: `Nudge now uses your own ${isNvidiaKey(k) ? "NVIDIA" : "Claude"} API key`, detail: `Ends in ${k.slice(-4)}`, tone: "good" });
    return k.slice(-4);
  },
});

export const saveAssistant = mutation({
  args: {
    autonomy,
    reminderChannel: v.union(v.literal("app"), v.literal("telegram"), v.literal("whatsapp")),
    quietFrom: v.string(),
    quietTo: v.string(),
    reminderLeadDays: v.number(),
    privateReminders: v.optional(v.boolean()),
    /** Which model answers in the app and on Telegram; "basic" = rules only. */
    assistantModel: v.optional(v.union(v.literal("auto"), v.literal("basic"), v.literal("claude-opus-5-5"), v.literal("claude-sonnet-5-5"), v.literal("claude-haiku-5-5"), v.literal("nvidia"))),
  },
  handler: async (ctx, args) => {
    const user = await requireViewer(ctx);
    const hhmm = (s: string) => s === "" || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s);
    if (!hhmm(args.quietFrom) || !hhmm(args.quietTo)) throw new ConvexError("Use HH:MM, or leave quiet hours off");
    if ((args.quietFrom === "") !== (args.quietTo === "")) throw new ConvexError("Set both quiet-hours times, or turn quiet hours off");
    if (args.quietFrom !== "" && args.quietFrom === args.quietTo) throw new ConvexError("Quiet hours need different start and end times, or turn them off");
    if (!Number.isInteger(args.reminderLeadDays) || args.reminderLeadDays < 0 || args.reminderLeadDays > 14) throw new ConvexError("Pick 0 to 14 days");
    const { assistantModel, ...rest } = args;
    await ctx.db.patch(user._id, { ...rest, ...(assistantModel ? { assistantModel: assistantModel === "auto" ? undefined : assistantModel } : {}) });
    const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    await ownAssistant(ctx, user, args.autonomy, wallet);
  },
});

export const setupWallet = mutation({
  args: { dailyCeilingMinor: v.number(), protectedMinor: v.number(), perPaymentMinor: v.number() },
  handler: async (ctx, args) => {
    const user = await requireViewer(ctx);
    for (const n of Object.values(args)) if (!minorOk(n)) throw new ConvexError("Amount is out of range");
    if (args.perPaymentMinor > args.dailyCeilingMinor) throw new ConvexError("A single payment can't exceed the daily ceiling");
    const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    if (wallet?.status === "live" && isVaultVersion(wallet.version)) {
      // Nothing the vault holds changes (the usual case right after making the passkey): save and
      // move on, no passkey (#122). Per-payment is the app's default for new grants, not a vault rule.
      const v = wallet.vault;
      if (v && v.ceilingMinor === args.dailyCeilingMinor && v.protectedMinor === args.protectedMinor) {
        await ctx.db.patch(wallet._id, { perPaymentMinor: args.perPaymentMinor, dailyCeilingMinor: v.ceilingMinor, protectedMinor: v.protectedMinor });
        await ownAssistant(ctx, user, user.autonomy ?? "approve", (await ctx.db.get(wallet._id))!);
        return null;
      }
      // The same change already waiting for the passkey: the same link, not a new request.
      const waiting = wallet.proposedPolicy ? await ctx.db.get(wallet.proposedPolicy.taskId) : null;
      if (
        waiting?.state === "awaiting_approval" &&
        waiting.approvalToken &&
        wallet.proposedPolicy!.dailyCeilingMinor === args.dailyCeilingMinor &&
        wallet.proposedPolicy!.protectedMinor === args.protectedMinor
      ) {
        await ctx.db.patch(wallet._id, { proposedPolicy: { ...wallet.proposedPolicy!, perPaymentMinor: args.perPaymentMinor } });
        return waiting.approvalToken;
      }
      // The vault enforces these. Our gateway takes whichever is stricter right away; the vault
      // changes when the owner signs (and, for looser limits, after its delay).
      const task = await policyTask(ctx, user, wallet, { protectedMinor: args.protectedMinor, dailyCeilingMinor: args.dailyCeilingMinor });
      await ctx.db.patch(wallet._id, {
        proposedPolicy: { ...args, taskId: task.taskId },
        protectedMinor: Math.max(wallet.protectedMinor, args.protectedMinor),
        dailyCeilingMinor: Math.min(wallet.dailyCeilingMinor, args.dailyCeilingMinor),
        perPaymentMinor: Math.min(wallet.perPaymentMinor ?? args.perPaymentMinor, args.perPaymentMinor),
      });
      return task.token;
    } else if (wallet) {
      await ctx.db.patch(wallet._id, args);
    } else {
      await ctx.db.insert("wallets", {
        userId: user._id,
        address: "",
        chain: "base-sepolia",
        asset: "USDC",
        balanceMinor: 0,
        frozen: false,
        ...args,
      });
      await ctx.db.insert("activity", {
        userId: user._id,
        kind: "setting",
        title: "Nudge wallet set up",
        detail: `Agents can spend up to $${(args.dailyCeilingMinor / 100).toFixed(2)} a day`,
        tone: "neutral",
      });
    }
    const fresh = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    await ownAssistant(ctx, user, user.autonomy ?? "approve", fresh);
    return null;
  },
});

export const addTestFunds = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireViewer(ctx);
    const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    if (!wallet) throw new ConvexError("Set up the wallet first");
    if (wallet.status === "live") throw new ConvexError("Your vault holds real test tokens on-chain; it was funded when it was created");
    if (wallet.balanceMinor >= 100_000) throw new ConvexError("Test balance is capped at $1,000");
    await ctx.db.patch(wallet._id, { balanceMinor: wallet.balanceMinor + 10_000 });
    await ctx.db.insert("activity", { userId: user._id, kind: "payment", title: "Added $100.00 tUSD (test dollars, no value)", detail: "Simulated funds", tone: "neutral" });
  },
});

function pairingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** Linking always starts here, in the signed-in app, never from the chat side. Codes last 10 minutes and work once. */
export const chatCode = mutation({
  args: { channel: v.union(v.literal("telegram"), v.literal("whatsapp")) },
  handler: async (ctx, { channel }) => {
    const user = await requireViewer(ctx);
    await hit(ctx, `chat-code:${user._id}`, 10, 3600_000);
    const existing = await ctx.db.query("chatLinks").withIndex("by_user", (q) => q.eq("userId", user._id)).take(10);
    const same = existing.find((l) => l.channel === channel);
    const code = pairingCode();
    const codeExpiresAt = Date.now() + 10 * 60_000;
    if (same) await ctx.db.patch(same._id, { code, codeExpiresAt });
    else await ctx.db.insert("chatLinks", { userId: user._id, channel, code, codeExpiresAt });
    return code;
  },
});

/** The owner's answer to "a new chat wants to link". */
export const confirmChat = mutation({
  args: { channel: v.union(v.literal("telegram"), v.literal("whatsapp")), accept: v.boolean() },
  handler: async (ctx, { channel, accept }) => {
    const user = await requireViewer(ctx);
    const link = (await ctx.db.query("chatLinks").withIndex("by_user", (q) => q.eq("userId", user._id)).take(10)).find((l) => l.channel === channel);
    if (!link?.pendingExternalId) return;
    if (accept) await ctx.db.patch(link._id, { externalId: link.pendingExternalId, linkedAt: Date.now(), pendingExternalId: undefined, pendingName: undefined });
    else await ctx.db.patch(link._id, { pendingExternalId: undefined, pendingName: undefined });
    await ctx.db.insert("activity", { userId: user._id, kind: "security", title: accept ? "Moved Telegram to a new chat" : "Refused a new Telegram chat", detail: link.pendingName, tone: accept ? "neutral" : "warn" });
  },
});

/** Outside assistants one owner may connect at once; each gets its own key, limits and vault key. */
const MAX_ASSISTANTS = 12;

export const addAssistant = mutation({
  args: {
    provider: v.union(v.literal("claude"), v.literal("chatgpt"), v.literal("openclaw"), v.literal("hermes"), v.literal("poke"), v.literal("instinct"), v.literal("other")),
    /** Required for "other": what the owner calls it (Codex, Gemini CLI, Instinct, ...). */
    name: v.optional(v.string()),
  },
  handler: async (ctx, { provider, name }) => {
    const user = await requireViewer(ctx);
    const agents = await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50);
    const live = agents.filter((a) => a.status !== "revoked" && a.provider !== "own");
    const label = (name ?? "").replace(/\s+/g, " ").trim().slice(0, 30);
    if (provider === "other") {
      if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(label)) throw new ConvexError("Name the assistant (letters, numbers, spaces, . _ -)");
      const same = live.find((a) => a.name.toLowerCase() === label.toLowerCase());
      if (same) return same._id;
    } else {
      const found = live.find((a) => a.provider === provider);
      if (found) return found._id;
    }
    if (live.length >= MAX_ASSISTANTS) throw new ConvexError(`Up to ${MAX_ASSISTANTS} assistants. Disconnect one first.`);
    const names = { claude: "Claude", chatgpt: "ChatGPT", openclaw: "OpenClaw", hermes: "Hermes", poke: "Poke", instinct: "Instinct", other: label };
    return await ctx.db.insert("agents", {
      userId: user._id,
      name: names[provider],
      provider,
      status: "pending",
      // It can see the money and ask for anything; every payment needs the owner's approval until
      // the owner gives it limits to pay on its own (Agents → Limits, signed with the passkey).
      scopes: ["read", "prepare", "request"],
      dailyCapMinor: 0,
      perPaymentMinor: 0,
      spentTodayMinor: 0,
      hidesBalances: false,
      connectedAt: Date.now(),
      expiresAt: Date.now() + 30 * DAY,
    });
  },
});

export const removeAssistant = mutation({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const user = await requireViewer(ctx);
    const agent = await ctx.db.get(agentId);
    if (!agent || agent.userId !== user._id || agent.provider === "own") throw new ConvexError("Not found");
    // A key that ever reached the vault is disconnected and frozen, never silently deleted.
    if (agent.chainAddress) return await revokeAgent(ctx, user, agent);
    await ctx.db.delete(agentId);
    return null;
  },
});

export const inviteFamily = mutation({
  args: { name: v.string(), relation: v.string(), country: v.string() },
  handler: async (ctx, args) => {
    const user = await requireViewer(ctx);
    const name = args.name.trim().slice(0, 40);
    if (!name) throw new ConvexError("Add their name");
    const c = countryInfo(args.country);
    return await ctx.db.insert("family", {
      userId: user._id,
      name,
      relation: args.relation.trim().slice(0, 30) || "Family",
      country: c.name,
      currency: c.currency,
      status: "invited",
    });
  },
});

export const complete = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireViewer(ctx);
    await ctx.db.patch(user._id, { onboardedAt: user.onboardedAt ?? Date.now(), onboardingStep: undefined });
    if (!user.onboardedAt) {
      await ctx.db.insert("messages", {
        userId: user._id,
        role: "assistant",
        text: `Hi ${user.name}. I can tell you what you can spend, list bills and subscriptions, and prepare payments. Try asking me something.`,
        channel: "app",
      });
    }
  },
});

/** Walk through setup again. With `fresh`, delete all of this user's data first. */
export const restart = mutation({
  args: { fresh: v.boolean() },
  handler: async (ctx, { fresh }) => {
    const user = await requireViewer(ctx);
    if (fresh && user.tokenIdentifier === JUDGE) throw new ConvexError("The judge account keeps its vault; it can't be wiped from the app");
    if (fresh) {
      await wipeUser(ctx, user._id);
      await ctx.db.patch(user._id, { onboardedAt: undefined, priorities: [], autonomy: undefined, incomeDay: undefined, nextIncomeAt: Date.now() + 30 * DAY });
    }
    await ctx.db.patch(user._id, { onboardingStep: "you" });
  },
});
