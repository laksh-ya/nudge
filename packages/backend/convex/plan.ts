import { v, ConvexError } from "convex/values";
import { formatMoney } from "@agent-wallet/domain";
import { mutation, query } from "./_generated/server";
import { currency } from "./schema";
import { own, requireViewer, viewer } from "./lib/auth";
import { computeOverview } from "./lib/overview";
import { goalPlan } from "./lib/assist";

/**
 * The Plan screen: money the owner expects in (salary, a refund) and out (a trip, a deposit) that
 * isn't a bill yet, plus bills and goals, laid out as a projection to a horizon. Expected income is
 * never counted as received until the owner marks it. The assistant reads the same data (get_plan).
 */

const DAY = 86_400_000;
const repeat = v.optional(v.union(v.literal("monthly"), v.literal("weekly")));

function step(at: number, r: "monthly" | "weekly" | undefined) {
  if (r === "weekly") return at + 7 * DAY;
  const d = new Date(at);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return [];
    return (await ctx.db.query("plans").withIndex("by_user_due", (q) => q.eq("userId", user._id)).take(200)).filter((p) => !p.done);
  },
});

export const add = mutation({
  args: { kind: v.union(v.literal("income"), v.literal("expense")), name: v.string(), amountMinor: v.number(), dueAt: v.number(), repeat, currency: v.optional(currency) },
  handler: async (ctx, args) => {
    const user = await requireViewer(ctx);
    const name = args.name.trim().replace(/\s+/g, " ").slice(0, 60);
    if (!name) throw new ConvexError("Name it (for example: Salary, Trip to Goa)");
    if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0 || args.amountMinor > 1e13) throw new ConvexError("Enter an amount");
    if (!Number.isFinite(args.dueAt)) throw new ConvexError("Pick a date");
    const open = (await ctx.db.query("plans").withIndex("by_user_due", (q) => q.eq("userId", user._id)).take(201)).filter((p) => !p.done);
    if (open.length >= 200) throw new ConvexError("Up to 200 plan items. Remove some first.");
    const id = await ctx.db.insert("plans", { userId: user._id, kind: args.kind, name, amountMinor: args.amountMinor, currency: args.currency ?? user.currency, dueAt: args.dueAt, repeat: args.repeat });
    // A salary moves the payday every projection counts to.
    if (args.kind === "income" && args.dueAt > Date.now() && (args.dueAt < user.nextIncomeAt || user.nextIncomeAt < Date.now())) {
      await ctx.db.patch(user._id, { nextIncomeAt: args.dueAt, incomeDay: new Date(args.dueAt).getUTCDate() });
    }
    return id;
  },
});

/** Received (income) or paid (expense): a repeating item moves to its next date, a one-off is done. */
export const markDone = mutation({
  args: { id: v.id("plans") },
  handler: async (ctx, { id }) => {
    const user = await requireViewer(ctx);
    const p = await own(user, await ctx.db.get(id));
    if (p.repeat) await ctx.db.patch(p._id, { dueAt: step(p.dueAt, p.repeat) });
    else await ctx.db.patch(p._id, { done: true });
    await ctx.db.insert("activity", { userId: user._id, kind: "setting", title: `${p.kind === "income" ? "Received" : "Paid"} ${p.name}`, detail: formatMoney(p.amountMinor, p.currency), tone: "neutral" });
    if (p.kind === "income" && p.repeat) await ctx.db.patch(user._id, { nextIncomeAt: step(p.dueAt, p.repeat) });
  },
});

export const remove = mutation({
  args: { id: v.id("plans") },
  handler: async (ctx, { id }) => {
    const user = await requireViewer(ctx);
    const p = await own(user, await ctx.db.get(id));
    await ctx.db.delete(p._id);
  },
});

/**
 * Day-by-day projection to the horizon: start from what's safe to spend now (cash after bills before
 * payday, the emergency fund and pending spends), add expected income on its dates, take away bills
 * after payday and planned expenses. Items in another currency are listed but left out of the line.
 */
export const projection = query({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days = 60 }) => {
    const user = await viewer(ctx);
    if (!user) return null;
    const now = Date.now();
    const horizon = now + Math.min(180, Math.max(14, days)) * DAY;
    const o = await computeOverview(ctx, user);
    const events: { at: number; name: string; amountMinor: number; kind: "income" | "bill" | "expense"; currency: string; counted: boolean; planId?: string }[] = [];
    for (const p of (await ctx.db.query("plans").withIndex("by_user_due", (q) => q.eq("userId", user._id).lte("dueAt", horizon)).take(200)).filter((x) => !x.done)) {
      for (let at = p.dueAt, i = 0; at <= horizon && i < 30; at = step(at, p.repeat), i++) {
        if (!p.repeat && i > 0) break;
        events.push({ at: Math.max(at, now), name: p.name, amountMinor: p.kind === "income" ? p.amountMinor : -p.amountMinor, kind: p.kind, currency: p.currency, counted: p.currency === user.currency, planId: p._id });
        if (!p.repeat) break;
      }
    }
    // Bills before payday are already taken out of "safe to spend"; later ones count on their dates.
    const bills = (await ctx.db.query("obligations").withIndex("by_user_due", (q) => q.eq("userId", user._id).gt("nextDueAt", user.nextIncomeAt).lte("nextDueAt", horizon)).take(200)).filter((b) => b.status === "active");
    for (const b of bills) events.push({ at: b.nextDueAt, name: b.name, amountMinor: -b.amountMinor, kind: "bill", currency: b.currency, counted: b.currency === user.currency });
    events.sort((a, b) => a.at - b.at);
    let running = o.available;
    const points = [{ at: now, balanceMinor: running }];
    for (const e of events) {
      if (!e.counted) continue;
      running += e.amountMinor;
      points.push({ at: e.at, balanceMinor: running });
    }
    points.push({ at: horizon, balanceMinor: running });
    const goals = (await ctx.db.query("goals").withIndex("by_user", (q) => q.eq("userId", user._id)).take(20)).map((g) => ({ ...g, plan: goalPlan(g, now) }));
    return { currency: user.currency, startMinor: o.available, endMinor: running, lowestMinor: Math.min(...points.map((p) => p.balanceMinor)), nextIncomeAt: user.nextIncomeAt, events, points, goals, horizon };
  },
});
