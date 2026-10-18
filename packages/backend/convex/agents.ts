import { v, ConvexError } from "convex/values";
import { isVaultVersion } from "@agent-wallet/domain";
import { internalMutation, mutation, query } from "./_generated/server";
import { unfreezeTask } from "./lib/actions";
import { freezeAgent, freezeAll as freezeAll_ } from "./lib/control";
import { own, requireViewer, viewer } from "./lib/auth";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return [];
    const agents = await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50);
    const recent = await ctx.db.query("tasks").withIndex("by_user_updated", (q) => q.eq("userId", user._id)).order("desc").take(150);
    const payees = new Map((await ctx.db.query("payees").withIndex("by_user", (q) => q.eq("userId", user._id)).take(200)).map((p) => [p._id, p.name]));
    return agents
      .filter((a) => a.status !== "revoked")
      .map(({ tokenHash, ...a }) => ({
        ...a,
        hasKey: Boolean(tokenHash),
        // Its last few payments and requests, for the card.
        recent: recent
          .filter((t) => t.agentId === a._id && t.amountMinor !== undefined)
          .slice(0, 3)
          .map((t) => ({ _id: t._id, title: t.purchase?.item ?? (t.payeeId ? (payees.get(t.payeeId) ?? t.title) : t.title), amountMinor: t.amountMinor!, state: t.state, at: t._creationTime })),
      }));
  },
});

export const setStatus = mutation({
  args: { agentId: v.id("agents"), status: v.union(v.literal("active"), v.literal("frozen")) },
  handler: async (ctx, { agentId, status }) => {
    const user = await requireViewer(ctx);
    const agent = await own(user, await ctx.db.get(agentId));
    if (agent.status === "revoked") throw new ConvexError("Agent was revoked");
    if (status === "frozen") {
      await freezeAgent(ctx, user, agent);
      await ctx.db.insert("activity", { userId: user._id, kind: "agent", title: `${agent.name} frozen`, tone: "warn" });
      return null;
    }
    const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    if (wallet?.status === "live" && isVaultVersion(wallet.version) && agent.chainAddress) {
      // Loosening needs the passkey. The agent stays frozen until the vault applies it.
      const taskId = await unfreezeTask(ctx, user, agent);
      return (await ctx.db.get(taskId))?.approvalToken ?? null;
    }
    await ctx.db.patch(agentId, { status: "active" });
    await ctx.db.insert("activity", { userId: user._id, kind: "agent", title: `${agent.name} unfrozen`, tone: "neutral" });
    return null;
  },
});

export const freezeAll = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireViewer(ctx);
    return await freezeAll_(ctx, user, "From the dashboard");
  },
});

/** Midnight in India (18:30 UTC). Per-agent daily allowances start again. */
export const resetDaily = internalMutation({
  args: {},
  handler: async (ctx) => {
    const agents = await ctx.db.query("agents").take(5000);
    // Agents with a vault key follow the vault's rolling 24 hours instead (read back in chain.ts).
    for (const a of agents) if (a.spentTodayMinor > 0 && !a.vault) await ctx.db.patch(a._id, { spentTodayMinor: 0 });
  },
});
