import { v, ConvexError } from "convex/values";
import { formatMoney, isVaultVersion } from "@agent-wallet/domain";
import { getAddress, isAddress, zeroAddress } from "viem";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { approveUrl, load, payeeForAddress } from "./gateway";
import { computeOverview } from "./lib/overview";
import { createReminder, goalPlan, telegramLinked, wantsTelegram } from "./lib/assist";
import { DAY, dateLabel, safeTz, zoned } from "./lib/schedule";
import { addContactTask } from "./lib/actions";
import { changeLimits } from "./lib/control";
import { newApprovalToken } from "./lib/seed";

/**
 * The MCP tools beyond paying: what's pending, the plan, reminders, goals, saving a contact and
 * asking for limits. Each reads or writes only the calling assistant's owner's data, and anything
 * that loosens what agents may do ends in an approval the owner signs.
 */

const iso = (at: number) => new Date(at).toISOString().slice(0, 10);

async function walletOf(ctx: QueryCtx, userId: Id<"users">) {
  return await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
}

/** A change the owner approves in the app (simulated wallet, no vault to sign for). */
async function settingsTask(
  ctx: MutationCtx,
  user: Doc<"users">,
  agent: Doc<"agents">,
  t: { title: string; reason: string; effects: NonNullable<Doc<"tasks">["effects"]> },
) {
  const token = newApprovalToken();
  const taskId = await ctx.db.insert("tasks", {
    userId: user._id,
    title: t.title,
    channel: "mcp",
    agentId: agent._id,
    state: "awaiting_approval",
    reason: t.reason,
    rail: "simulator",
    approvalToken: token,
    expiresAt: Date.now() + 24 * 60 * 60_000,
    updatedAt: Date.now(),
    effects: t.effects,
  });
  return { taskId, token };
}

const OPEN = ["awaiting_approval", "held", "reserved", "submitted", "queued", "unknown"] as const;

export const pending = internalQuery({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const { user } = await load(ctx, agentId);
    const now = Date.now();
    const tz = safeTz(user.timezone);
    const rows = (await Promise.all(OPEN.map((state) => ctx.db.query("tasks").withIndex("by_user_state", (q) => q.eq("userId", user._id).eq("state", state)).take(50)))).flat();
    const names = new Map<string, string>();
    for (const p of await ctx.db.query("payees").withIndex("by_user", (q) => q.eq("userId", user._id)).take(200)) names.set(p._id, p.name);
    for (const a of await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50)) names.set(a._id, a.name);
    const bills = (await ctx.db.query("obligations").withIndex("by_user_due", (q) => q.eq("userId", user._id).gte("nextDueAt", now - DAY).lte("nextDueAt", now + 14 * DAY)).take(50)).filter(
      (b) => b.status === "active",
    );
    const reminders = await ctx.db.query("reminders").withIndex("by_user", (q) => q.eq("userId", user._id).eq("status", "scheduled")).take(20);
    const watches = (await ctx.db.query("watches").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50)).filter((w) => w.status === "active" || w.status === "waiting");
    return {
      waitingForApproval: rows
        .filter((t) => t.state === "awaiting_approval")
        .map((t) => ({
          taskId: t._id,
          what: t.title,
          amount: t.amountMinor !== undefined ? formatMoney(t.amountMinor, t.currency ?? "USDC") : null,
          to: t.payeeId ? (names.get(t.payeeId) ?? null) : null,
          askedBy: t.agentId ? (names.get(t.agentId) ?? null) : "you",
          why: t.reason ?? null,
          approvalUrl: t.approvalToken ? approveUrl(t.approvalToken) : null,
          expires: t.expiresAt ? new Date(t.expiresAt).toISOString() : null,
        })),
      onTheirWay: rows
        .filter((t) => t.state !== "awaiting_approval")
        .map((t) => ({
          taskId: t._id,
          what: t.title,
          state: t.state,
          amount: t.amountMinor !== undefined ? formatMoney(t.amountMinor, t.currency ?? "USDC") : null,
          releasesAt: t.state === "held" && t.releaseAt ? new Date(t.releaseAt).toISOString() : null,
        })),
      billsDueSoon: bills.map((b) => ({ name: b.name, kind: b.kind, amount: formatMoney(b.amountMinor, b.currency), due: iso(b.nextDueAt), dueIn: dateLabel(b.nextDueAt, tz) })),
      reminders: reminders.map((r) => ({ reminderId: r._id, text: r.text, at: new Date(r.dueAt).toISOString(), repeat: r.repeat ?? null })),
      priceWatches: watches.map((w) => ({ watchId: w._id, item: w.item, buyAtOrBelow: formatMoney(w.maxPriceMinor, "USDC"), lastPrice: w.lastPriceMinor !== undefined ? formatMoney(w.lastPriceMinor, "USDC") : null, status: w.status })),
    };
  },
});

export const plan = internalQuery({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const { agent, user } = await load(ctx, agentId);
    const now = Date.now();
    const o = await computeOverview(ctx, user);
    const horizon = Math.max(user.nextIncomeAt, now + 31 * DAY);
    const items = (await ctx.db.query("plans").withIndex("by_user_due", (q) => q.eq("userId", user._id).gte("dueAt", now - 7 * DAY).lte("dueAt", horizon)).take(100)).filter((p) => !p.done);
    const goals = await ctx.db.query("goals").withIndex("by_user", (q) => q.eq("userId", user._id)).take(20);
    const m = (n: number, c: Doc<"plans">["currency"] = user.currency) => formatMoney(n, c);
    return {
      nextIncome: { date: iso(user.nextIncomeAt), inDays: o.daysToIncome },
      ...(agent.hidesBalances ? { balances: "hidden by the user" } : { safeToSpendNow: m(o.available), perDayUntilIncome: m(o.perDay), billsBeforeIncome: m(o.commitments) }),
      expectedIn: items.filter((p) => p.kind === "income").map((p) => ({ name: p.name, amount: m(p.amountMinor, p.currency), date: iso(p.dueAt), repeat: p.repeat ?? null, received: false })),
      expectedOut: items.filter((p) => p.kind === "expense").map((p) => ({ name: p.name, amount: m(p.amountMinor, p.currency), date: iso(p.dueAt), repeat: p.repeat ?? null })),
      goals: goals.map((g) => {
        const gp = goalPlan(g, now);
        return { name: g.name, target: m(g.targetMinor, g.currency), saved: m(g.savedMinor, g.currency), by: g.dueAt ? iso(g.dueAt) : null, perMonthNeeded: gp.monthly !== null ? m(gp.monthly, g.currency) : null };
      }),
      note: "Expected income isn't counted as received until the user marks it. Plan items are the user's own entries (Plan screen).",
    };
  },
});

export const reminders = internalQuery({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const { user } = await load(ctx, agentId);
    const tz = safeTz(user.timezone);
    const rows = await ctx.db.query("reminders").withIndex("by_user", (q) => q.eq("userId", user._id).eq("status", "scheduled")).take(100);
    const lead = user.reminderLeadDays ?? 2;
    return {
      reminders: rows.sort((a, b) => a.dueAt - b.dueAt).map((r) => ({ reminderId: r._id, text: r.text, at: new Date(r.dueAt).toISOString(), when: dateLabel(r.dueAt, tz, true), repeat: r.repeat ?? null })),
      automatic: `Bills and renewals are reminded ${lead === 0 ? "on the day" : `${lead} day${lead === 1 ? "" : "s"} before`}${user.quietFrom ? `, outside quiet hours (${user.quietFrom}–${user.quietTo})` : ""}.`,
      deliveredTo: wantsTelegram(user) && (await telegramLinked(ctx, user._id)) ? "app and Telegram" : "app",
    };
  },
});

/** "2026-11-01" means 9am that day in the owner's time zone; a full ISO date-time is used as is. */
export function parseAt(at: string, tz: string): number | null {
  const day = at.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  // zoned() counts months from 0.
  if (day) return zoned(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 9, 0, tz);
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : null;
}

export const setReminder = internalMutation({
  args: { agentId: v.id("agents"), text: v.string(), at: v.string(), repeat: v.optional(v.string()) },
  handler: async (ctx, { agentId, text, at, repeat }) => {
    const { agent, user } = await load(ctx, agentId);
    const tz = safeTz(user.timezone);
    const what = text.trim().replace(/\s+/g, " ").slice(0, 140);
    if (!what) throw new ConvexError("Say what to remind about");
    const dueAt = parseAt(at, tz);
    if (dueAt === null) throw new ConvexError(`"at" must be an ISO date-time like 2026-11-01T09:00:00+05:30, or a date like 2026-11-01`);
    if (dueAt < Date.now() - 60_000) throw new ConvexError("That time has passed. Pick a time in the future.");
    if (dueAt > Date.now() + 400 * DAY) throw new ConvexError("Reminders can be up to about a year ahead");
    const rep = repeat === "monthly" || repeat === "weekly" ? repeat : undefined;
    if (repeat && !rep) throw new ConvexError(`repeat must be "weekly" or "monthly"`);
    const reminderId = await createReminder(ctx, user, { text: what, dueAt, repeat: rep });
    await ctx.db.insert("activity", { userId: user._id, kind: "setting", title: `${agent.name} set a reminder: ${what}`, detail: dateLabel(dueAt, tz, true), tone: "neutral" });
    return { reminderId, text: what, at: new Date(dueAt).toISOString(), when: dateLabel(dueAt, tz, true), repeat: rep ?? null };
  },
});

export const cancelReminder = internalMutation({
  args: { agentId: v.id("agents"), reminderId: v.string() },
  handler: async (ctx, { agentId, reminderId }) => {
    const { user } = await load(ctx, agentId);
    const id = ctx.db.normalizeId("reminders", reminderId);
    const r = id ? await ctx.db.get(id) : null;
    if (!r || r.userId !== user._id) throw new ConvexError("No such reminder; use list_reminders");
    if (r.status === "scheduled") await ctx.db.patch(r._id, { status: "cancelled" });
    return { cancelled: true, text: r.text };
  },
});

export const addBill = internalMutation({
  args: { agentId: v.id("agents"), name: v.string(), amount: v.number(), due: v.string(), repeats: v.optional(v.string()), kind: v.optional(v.string()), contactId: v.optional(v.string()), payWith: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const { agent, user } = await load(ctx, a.agentId);
    const name = a.name.trim().replace(/\s+/g, " ").slice(0, 60);
    if (!name) throw new ConvexError("Name the bill");
    const cadence = (a.repeats ?? "monthly") as "weekly" | "monthly" | "yearly";
    if (!["weekly", "monthly", "yearly"].includes(cadence)) throw new ConvexError("repeats must be weekly, monthly or yearly");
    const kind = (a.kind ?? "bill") as "bill" | "subscription";
    if (!["bill", "subscription"].includes(kind)) throw new ConvexError("kind must be bill or subscription");
    const payWith = a.payWith === "wallet" ? "wallet" : "manual";
    const due = parseAt(a.due, safeTz(user.timezone));
    if (due === null) throw new ConvexError("due must be a date like 2026-11-01");
    const currency = payWith === "wallet" ? ("USD" as const) : user.currency;
    const amountMinor = Math.round(a.amount * 100);
    if (!(amountMinor > 0) || amountMinor > 1e13) throw new ConvexError("amount must be positive");
    const payeeId = a.contactId ? ctx.db.normalizeId("payees", a.contactId) : null;
    if (a.contactId) {
      const p = payeeId ? await ctx.db.get(payeeId) : null;
      if (!p || p.userId !== user._id) throw new ConvexError("Unknown contactId; use list_contacts");
    }
    if (payWith === "wallet" && !payeeId) throw new ConvexError("A bill the wallet pays needs contactId (who it's paid to)");
    const id = await ctx.db.insert("obligations", {
      userId: user._id,
      name,
      kind,
      amountMinor,
      currency,
      cadence,
      nextDueAt: due,
      status: "active",
      source: "manual",
      payWith,
      ...(payeeId ? { payeeId } : {}),
    });
    await ctx.db.insert("activity", { userId: user._id, kind: "setting", title: `${agent.name} added ${name}`, detail: `${formatMoney(amountMinor, currency)} ${cadence}`, tone: "neutral" });
    return { billId: id, name, amount: formatMoney(amountMinor, currency), nextDue: iso(due), repeats: cadence, message: "Added. The user will be reminded before it's due." };
  },
});

export const addPlan = internalMutation({
  args: { agentId: v.id("agents"), kind: v.string(), name: v.string(), amount: v.number(), date: v.string(), repeats: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const { agent, user } = await load(ctx, a.agentId);
    if (a.kind !== "income" && a.kind !== "expense") throw new ConvexError("kind must be income or expense");
    const name = a.name.trim().replace(/\s+/g, " ").slice(0, 60);
    if (!name) throw new ConvexError("Name it");
    const at = parseAt(a.date, safeTz(user.timezone));
    if (at === null) throw new ConvexError("date must be like 2026-11-01");
    const repeat = a.repeats === "monthly" || a.repeats === "weekly" ? a.repeats : undefined;
    if (a.repeats && !repeat) throw new ConvexError("repeats must be weekly or monthly");
    const amountMinor = Math.round(a.amount * 100);
    if (!(amountMinor > 0) || amountMinor > 1e13) throw new ConvexError("amount must be positive");
    const id = await ctx.db.insert("plans", { userId: user._id, kind: a.kind, name, amountMinor, currency: user.currency, dueAt: at, repeat });
    if (a.kind === "income" && at > Date.now() && (at < user.nextIncomeAt || user.nextIncomeAt < Date.now())) await ctx.db.patch(user._id, { nextIncomeAt: at });
    await ctx.db.insert("activity", { userId: user._id, kind: "setting", title: `${agent.name} added ${name} to your plan`, detail: formatMoney(amountMinor, user.currency), tone: "neutral" });
    return { planId: id, name, amount: formatMoney(amountMinor, user.currency), date: iso(at), repeats: repeat ?? null };
  },
});

export const goals = internalQuery({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const { user } = await load(ctx, agentId);
    const rows = await ctx.db.query("goals").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50);
    return rows.map((g) => {
      const gp = goalPlan(g, Date.now());
      return {
        name: g.name,
        target: formatMoney(g.targetMinor, g.currency),
        saved: formatMoney(g.savedMinor, g.currency),
        percent: g.targetMinor ? Math.min(100, Math.floor((g.savedMinor / g.targetMinor) * 100)) : 0,
        by: g.dueAt ? iso(g.dueAt) : null,
        perMonthNeeded: gp.monthly !== null ? formatMoney(gp.monthly, g.currency) : null,
      };
    });
  },
});

export const addContact = internalMutation({
  args: { agentId: v.id("agents"), name: v.string(), address: v.string(), kind: v.optional(v.string()) },
  handler: async (ctx, { agentId, name, address, kind }) => {
    const { agent, user } = await load(ctx, agentId);
    const raw = address.trim();
    if (!isAddress(raw, { strict: false }) || getAddress(raw) === zeroAddress) throw new ConvexError("That isn't a Base Sepolia address (0x followed by 40 hex characters).");
    const w = await walletOf(ctx, user._id);
    if (w?.address && w.address.toLowerCase() === raw.toLowerCase()) throw new ConvexError("That's the user's own wallet");
    const payee = (await payeeForAddress(ctx, user, raw, name, kind === "merchant" ? "merchant" : "person"))!;
    const trusted = payee.trusted && !payee.pendingPasskey && !(payee.activeAt && payee.activeAt > Date.now());
    if (trusted) return { contactId: payee._id, name: payee.name, trusted: true, message: `${payee.name} is already a trusted contact.` };
    await ctx.db.insert("activity", { userId: user._id, kind: "setting", title: `${agent.name} asked to save ${payee.name}`, detail: "Waiting for your approval", tone: "neutral" });
    if (w?.status === "live" && isVaultVersion(w.version)) {
      const { taskId, token } = await addContactTask(ctx, user, payee, w);
      await ctx.db.patch(taskId, { agentId: agent._id, channel: "mcp" });
      return {
        outcome: "needs_approval",
        contactId: payee._id,
        taskId,
        approvalUrl: approveUrl(token),
        message: `Give the user this link to add ${payee.name} with their passkey. After that (and the vault's short waiting period) you can pay it within your limits.`,
      };
    }
    const { taskId, token } = await settingsTask(ctx, user, agent, {
      title: `Add ${payee.name} to your contacts`,
      reason: `${agent.name} wants to pay ${payee.name}. Trusted contacts can be paid within its limits without asking.`,
      effects: { agents: [], payees: [payee._id] },
    });
    return { outcome: "needs_approval", contactId: payee._id, taskId, approvalUrl: approveUrl(token), message: `Give the user this link to approve ${payee.name} as a trusted contact.` };
  },
});

export const requestLimits = internalMutation({
  args: { agentId: v.id("agents"), perPayment: v.number(), perDay: v.number(), days: v.optional(v.number()), why: v.string() },
  handler: async (ctx, { agentId, perPayment, perDay, days, why }) => {
    const { agent, user } = await load(ctx, agentId);
    const toMinor = (n: number) => Math.round(n * 100);
    if (![perPayment, perDay].every((n) => Number.isFinite(n) && n >= 0 && n <= 100_000)) throw new ConvexError("Limits are US dollars from 0 to 100000");
    const per = toMinor(perPayment);
    const daily = toMinor(perDay);
    if (per > daily) throw new ConvexError("perPayment can't be more than perDay");
    if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 365)) throw new ConvexError("days must be a whole number from 1 to 365");
    const expiresAt = days ? Date.now() + days * DAY : agent.expiresAt;
    const scopes: Doc<"agents">["scopes"] = per > 0 ? ["read", "prepare", "spend", "request"] : ["read", "prepare", "request"];
    const looser = per > agent.perPaymentMinor || daily > agent.dailyCapMinor || expiresAt > agent.expiresAt + 60_000 || (per > 0 && !agent.scopes.includes("spend"));
    const text = `${formatMoney(per, "USDC")} a payment, ${formatMoney(daily, "USDC")} a day${days ? ` for ${days} days` : ""}`;
    if (!looser) {
      await changeLimits(ctx, user, agent, { scopes, perPaymentMinor: per, dailyCapMinor: daily, expiresAt });
      await ctx.db.insert("activity", { userId: user._id, kind: "agent", title: `${agent.name} lowered its own limits`, detail: text, tone: "neutral" });
      return { outcome: "applied", message: `Done: ${text}. Lower limits apply at once.` };
    }
    const w = await walletOf(ctx, user._id);
    const chain = Boolean(w?.status === "live" && isVaultVersion(w.version) && agent.chainAddress && agent.onchain);
    let taskId: Id<"tasks">;
    let token: string;
    if (chain) {
      const t = await changeLimits(ctx, user, agent, { scopes, perPaymentMinor: per, dailyCapMinor: daily, expiresAt });
      if (!t) return { outcome: "applied", message: `Done: ${text}.` };
      const task = await ctx.db.query("tasks").withIndex("by_approval_token", (q) => q.eq("approvalToken", t)).unique();
      taskId = task!._id;
      token = t;
      await ctx.db.patch(taskId, { channel: "mcp", reason: `${agent.name} asks: ${why.trim().slice(0, 140)}. The vault enforces agents' limits, so raising them needs your passkey.` });
    } else {
      ({ taskId, token } = await settingsTask(ctx, user, agent, {
        title: `Let ${agent.name} pay ${text} on its own`,
        reason: `${agent.name} asks: ${why.trim().slice(0, 140)}`,
        effects: { agents: [], payees: [], grant: { agentId: agent._id, perPaymentMinor: per, dailyCapMinor: daily, expiresAt, scopes } },
      }));
    }
    await ctx.db.insert("activity", { userId: user._id, kind: "agent", title: `${agent.name} asked for new limits`, detail: text, tone: "neutral" });
    return { outcome: "needs_approval", taskId, approvalUrl: approveUrl(token), message: `Give the user this link to approve ${text}.` };
  },
});
