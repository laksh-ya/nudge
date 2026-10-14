import { query } from "./_generated/server";
import { viewer } from "./lib/auth";
import { computeOverview } from "./lib/overview";

export const overview = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return null;
    const overview = await computeOverview(ctx, user);
    const waiting = await ctx.db
      .query("tasks")
      .withIndex("by_user_state", (q) => q.eq("userId", user._id).eq("state", "awaiting_approval"))
      .take(10);
    const unknown = await ctx.db
      .query("tasks")
      .withIndex("by_user_state", (q) => q.eq("userId", user._id).eq("state", "unknown"))
      .take(10);
    const requests = (
      await ctx.db
        .query("familyRequests")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .take(50)
    ).filter((r) => r.state === "requested");
    const payees = new Map(
      (await ctx.db.query("payees").withIndex("by_user", (q) => q.eq("userId", user._id)).take(200)).map(
        (p) => [p._id, p.name],
      ),
    );
    const agents = new Map(
      (await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50)).map(
        (a) => [a._id, a.provider],
      ),
    );
    const named = (t: (typeof waiting)[number]) => ({
      ...t,
      payee: t.payeeId ? payees.get(t.payeeId) : undefined,
      agentProvider: t.agentId ? agents.get(t.agentId) : undefined,
    });
    const priceRises = overview.upcoming.filter(
      (o) => o.previousAmountMinor !== undefined && o.amountMinor > o.previousAmountMinor,
    );
    return {
      name: user.name,
      overview,
      attention: {
        approvals: waiting.map(named),
        unknown: unknown.map(named),
        familyRequests: requests.length,
        priceRises: priceRises.map((o) => ({ name: o.name, from: o.previousAmountMinor!, to: o.amountMinor, currency: o.currency })),
      },
    };
  },
});
