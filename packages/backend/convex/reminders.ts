import { v, ConvexError } from "convex/values";
import { formatMoney } from "@agent-wallet/domain";
import { internalAction, internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireViewer, viewer } from "./lib/auth";
import { createReminder, goalPlan, telegramLinked, wantsTelegram } from "./lib/assist";
import { DAY, MINUTE, afterQuietHours, daysUntil, dateLabel, inQuietHours, nextRepeat, safeTz, whenWords } from "./lib/schedule";

/**
 * Reminders that actually arrive (#12): bills and renewals `reminderLeadDays` ahead, goals whose date
 * is close, and anything the owner asked for in chat. Each goes into the app's chat thread and to
 * Telegram when it is linked, never during the owner's quiet hours (it waits for them to end), and
 * each bill cycle is reminded once. WhatsApp isn't built, so nothing is sent there.
 */

const DEFAULT_LEAD_DAYS = 2;
/** Goals get at least a week's notice before their date. */
const GOAL_LEAD_DAYS = 7;
/** Bills overdue longer than this aren't reminded about any more; Home shows them instead. */
const STALE_AFTER = DAY;
const BATCH = 500;

/** `pay`: the words that pay the bill from the chat ("Pay Rent"), offered as a button and a Telegram reply. */
type Note = { text: string; privateText: string; pay?: string };

/** Puts a reminder in the owner's chat thread and sends it to Telegram if linked and wanted. */
async function deliver(ctx: MutationCtx, user: Doc<"users">, note: Note, opts: { telegram?: boolean; key: string }) {
  if (await ctx.db.query("reminderDeliveries").withIndex("by_key", (q) => q.eq("key", opts.key)).unique()) return { telegram: false };
  await ctx.db.insert("messages", { userId: user._id, role: "assistant", text: note.text, channel: "app", reminder: true, ...(note.pay ? { suggestions: [note.pay, "Not now"] } : {}) });
  const toTelegram = (opts.telegram ?? wantsTelegram(user)) && (await telegramLinked(ctx, user._id));
  if (toTelegram) {
    const text = note.pay ? `${note.text} Reply "${note.pay.toLowerCase()}" and I'll take care of it.` : note.text;
    const deliveryId = await ctx.db.insert("reminderDeliveries", { userId: user._id, key: opts.key, text, privateText: note.privateText, status: "queued", attempts: 0, nextAttemptAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.reminders.deliverTelegram, { deliveryId });
  }
  return { telegram: toTelegram };
}

function billNote(bill: Doc<"obligations">, now: number, tz: string): Note {
  const when = whenWords(bill.nextDueAt, now, tz);
  const amount = formatMoney(bill.amountMinor, bill.currency);
  if (bill.kind === "subscription") {
    const change = bill.previousAmountMinor && bill.previousAmountMinor !== bill.amountMinor ? ` (was ${formatMoney(bill.previousAmountMinor, bill.currency)})` : "";
    return { text: `Reminder: ${bill.name} renews ${when} for ${amount}${change}.`, privateText: `Reminder: a subscription renews ${when}. Open the app for details.` };
  }
  // A bill the owner told us how to pay comes with a one-tap "pay it": the same chat order as typing it.
  const payable = bill.payWith === "wallet" || bill.payWith === "account" || bill.payeeId;
  const how = bill.payWith === "wallet" ? " Your wallet can pay it" : bill.payWith === "account" ? " I can open the payment for you" : "";
  return {
    text: `Reminder: ${bill.name} ${amount} is due ${when}.${payable ? `${how}: tap Pay ${bill.name}.` : ""}`,
    privateText: `Reminder: a bill is due ${when}. Open the app for details.`,
    ...(payable ? { pay: `Pay ${bill.name}` } : {}),
  };
}

function goalNote(goal: Doc<"goals">, now: number, tz: string): Note {
  const plan = goalPlan(goal, now);
  const money = (n: number) => formatMoney(n, goal.currency);
  return {
    text: `Reminder: your ${goal.name} goal is due ${whenWords(goal.dueAt!, now, tz)}. ${money(goal.savedMinor)} of ${money(goal.targetMinor)} saved, ${money(plan.remaining)} to go.`,
    privateText: `Reminder: a savings goal is due ${whenWords(goal.dueAt!, now, tz)}. Open the app for details.`,
  };
}

async function chatReminderNote(ctx: MutationCtx, r: Doc<"reminders">, now: number, tz: string): Promise<Note> {
  const bill = r.obligationId ? await ctx.db.get(r.obligationId) : null;
  const detail = bill && bill.status === "active" ? ` ${bill.name} is ${formatMoney(bill.amountMinor, bill.currency)}, due ${whenWords(bill.nextDueAt, now, tz)}.` : "";
  return { text: `Reminder: ${r.text}.${detail}`, privateText: "Reminder: you asked me to remind you about something. Open the app to see it." };
}

/**
 * Every 15 minutes. Anything held back by quiet hours is simply not marked as sent, so the first
 * run after the quiet hours end sends it.
 */
export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const users = new Map<Id<"users">, Doc<"users"> | null>();
    const userOf = async (id: Id<"users">) => {
      if (!users.has(id)) users.set(id, await ctx.db.get(id));
      return users.get(id) ?? null;
    };
    const quiet = (u: Doc<"users">) => inQuietHours(now, safeTz(u.timezone), u.quietFrom, u.quietTo);
    let sent = 0;
    let deferred = 0;

    // What the owner asked for in chat.
    const due = await ctx.db.query("reminders").withIndex("by_status_due", (q) => q.eq("status", "scheduled").lte("dueAt", now)).take(BATCH);
    for (const r of due) {
      const user = await userOf(r.userId);
      if (!user) {
        await ctx.db.patch(r._id, { status: "cancelled" });
        continue;
      }
      if (quiet(user)) {
        deferred++;
        continue;
      }
      const tz = safeTz(user.timezone);
      await deliver(ctx, user, await chatReminderNote(ctx, r, now, tz), { key: `reminder:${r._id}:${r.dueAt}` });
      if (r.repeat) {
        let next = nextRepeat(r.dueAt, r.repeat, tz, r.repeatDay);
        while (next <= now) next = nextRepeat(next, r.repeat, tz, r.repeatDay);
        await ctx.db.patch(r._id, { dueAt: next, sentAt: now });
      } else {
        await ctx.db.patch(r._id, { status: "sent", sentAt: now });
      }
      sent++;
    }

    // Bills and renewals, each cycle once, `reminderLeadDays` calendar days ahead in the owner's zone.
    const bills = await ctx.db
      .query("obligations")
      .withIndex("by_due", (q) => q.gte("nextDueAt", now - STALE_AFTER).lte("nextDueAt", now + 15 * DAY))
      .take(BATCH * 4);
    for (const b of bills) {
      if (b.status !== "active" || b.remindedFor === b.nextDueAt) continue;
      const user = await userOf(b.userId);
      if (!user) continue;
      const tz = safeTz(user.timezone);
      if (daysUntil(b.nextDueAt, now, tz) > (user.reminderLeadDays ?? DEFAULT_LEAD_DAYS)) continue;
      if (quiet(user)) {
        deferred++;
        continue;
      }
      await deliver(ctx, user, billNote(b, now, tz), { key: `bill:${b._id}:${b.nextDueAt}` });
      await ctx.db.patch(b._id, { remindedFor: b.nextDueAt });
      sent++;
    }

    // Goals with a date coming up that aren't reached yet.
    const goals = await ctx.db
      .query("goals")
      .withIndex("by_due", (q) => q.gte("dueAt", now).lte("dueAt", now + 15 * DAY))
      .take(BATCH);
    for (const g of goals) {
      if (!g.dueAt || g.remindedFor === g.dueAt || g.savedMinor >= g.targetMinor) continue;
      const user = await userOf(g.userId);
      if (!user) continue;
      const tz = safeTz(user.timezone);
      if (daysUntil(g.dueAt, now, tz) > Math.max(GOAL_LEAD_DAYS, user.reminderLeadDays ?? DEFAULT_LEAD_DAYS)) continue;
      if (quiet(user)) {
        deferred++;
        continue;
      }
      await deliver(ctx, user, goalNote(g, now, tz), { key: `goal:${g._id}:${g.dueAt}` });
      await ctx.db.patch(g._id, { remindedFor: g.dueAt });
      sent++;
    }
    if (sent || deferred) console.info("reminders.run", { sent, deferred });
    return { sent, deferred };
  },
});

/**
 * "Send test reminder" in Settings: one reminder now, through the same delivery path, so the owner
 * sees what arrives where. It ignores quiet hours because the owner asked for it this moment.
 */
export const sendTest = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireViewer(ctx);
    const now = Date.now();
    const tz = safeTz(user.timezone);
    const next = (await ctx.db.query("obligations").withIndex("by_user_due", (q) => q.eq("userId", user._id).gte("nextDueAt", now)).take(20)).find(
      (o) => o.status === "active",
    );
    const note: Note = next
      ? { text: `Test reminder. This is how reminders arrive: ${billNote(next, now, tz).text.replace(/^Reminder: /, "")}`, privateText: `Test reminder. ${billNote(next, now, tz).privateText.replace(/^Reminder: /, "")}` }
      : { text: "Test reminder. Bill, renewal and goal reminders will arrive here like this.", privateText: "Test reminder. Reminders will arrive here like this." };
    const linked = await telegramLinked(ctx, user._id);
    const { telegram } = await deliver(ctx, user, note, { key: `test:${user._id}:${now}`, telegram: linked && user.reminderChannel !== "app" });
    return {
      app: true,
      telegram,
      telegramLinked: linked,
      quietNow: inQuietHours(now, tz, user.quietFrom, user.quietTo),
    };
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return [];
    const tz = safeTz(user.timezone);
    const rows = await ctx.db.query("reminders").withIndex("by_user", (q) => q.eq("userId", user._id).eq("status", "scheduled")).take(100);
    return rows.map((r) => ({ _id: r._id, text: r.text, dueAt: r.dueAt, repeat: r.repeat ?? null, when: dateLabel(r.dueAt, tz, true) }));
  },
});

/** A reminder the owner sets from the Plan screen (the same row a chat or an agent creates). */
export const create = mutation({
  args: { text: v.string(), dueAt: v.number(), repeat: v.optional(v.union(v.literal("monthly"), v.literal("weekly"))), obligationId: v.optional(v.id("obligations")) },
  handler: async (ctx, { text, dueAt, repeat, obligationId }) => {
    const user = await requireViewer(ctx);
    const what = text.trim().replace(/\s+/g, " ").slice(0, 140);
    if (!what) throw new ConvexError("Say what to remind you about");
    if (!Number.isFinite(dueAt) || dueAt < Date.now() - 60_000) throw new ConvexError("Pick a time in the future");
    if (dueAt > Date.now() + 400 * DAY) throw new ConvexError("Up to about a year ahead");
    if (obligationId) {
      const b = await ctx.db.get(obligationId);
      if (!b || b.userId !== user._id) throw new ConvexError("No such bill");
    }
    return await createReminder(ctx, user, { text: what, dueAt, repeat, obligationId });
  },
});

export const cancel = mutation({
  args: { reminderId: v.id("reminders") },
  handler: async (ctx, { reminderId }) => {
    const user = await requireViewer(ctx);
    const r = await ctx.db.get(reminderId);
    if (!r || r.userId !== user._id) throw new ConvexError("No such reminder");
    if (r.status === "scheduled") await ctx.db.patch(r._id, { status: "cancelled" });
  },
});

/** Claim once before the network call. A crash after sending stays unknown rather than risking a duplicate. */
export const claimDelivery = internalMutation({
  args: { deliveryId: v.id("reminderDeliveries") },
  handler: async (ctx, { deliveryId }) => {
    const row = await ctx.db.get(deliveryId);
    if (!row || row.status !== "queued" || row.nextAttemptAt > Date.now()) return null;
    const user = await ctx.db.get(row.userId);
    if (!user || !wantsTelegram(user) || !(await telegramLinked(ctx, row.userId))) {
      await ctx.db.patch(deliveryId, { status: "failed", error: "Telegram unlinked or disabled" });
      return null;
    }
    const next = afterQuietHours(Date.now(), safeTz(user.timezone), user.quietFrom, user.quietTo);
    if (!row.key.startsWith("test:") && next > Date.now()) {
      await ctx.db.patch(deliveryId, { nextAttemptAt: next });
      await ctx.scheduler.runAt(next, internal.reminders.deliverTelegram, { deliveryId });
      return null;
    }
    await ctx.db.patch(deliveryId, { status: "sending", attempts: row.attempts + 1 });
    return { userId: row.userId, text: user.privateReminders ? row.privateText : row.text };
  },
});

export const finishDelivery = internalMutation({
  args: { deliveryId: v.id("reminderDeliveries"), ok: v.boolean(), retryAfter: v.optional(v.number()), error: v.optional(v.string()), unknown: v.optional(v.boolean()) },
  handler: async (ctx, { deliveryId, ok, retryAfter, error, unknown }) => {
    const row = await ctx.db.get(deliveryId);
    if (!row || row.status !== "sending") return;
    if (!ok && retryAfter !== undefined && row.attempts < 3) {
      const nextAttemptAt = Date.now() + Math.max(1, Math.min(retryAfter, 86400)) * 1000;
      await ctx.db.patch(deliveryId, { status: "queued", nextAttemptAt, error });
      await ctx.scheduler.runAt(nextAttemptAt, internal.reminders.deliverTelegram, { deliveryId });
    } else {
      await ctx.db.patch(deliveryId, { status: ok ? "sent" : unknown ? "unknown" : "failed", error });
    }
  },
});

export const deliverTelegram = internalAction({
  args: { deliveryId: v.id("reminderDeliveries") },
  handler: async (ctx, { deliveryId }) => {
    const claimed = await ctx.runMutation(internal.reminders.claimDelivery, { deliveryId });
    if (!claimed) return;
    try {
      const result = await ctx.runAction(internal.telegram.send, claimed);
      await ctx.runMutation(internal.reminders.finishDelivery, { deliveryId, ok: Boolean(result?.ok), retryAfter: result?.retryAfter, error: result?.reason, unknown: result?.unknown });
    } catch {
      await ctx.runMutation(internal.reminders.finishDelivery, { deliveryId, ok: false, unknown: true, error: "Delivery outcome unavailable; not retried to avoid duplicate notifications" });
    }
  },
});
