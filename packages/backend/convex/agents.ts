import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { unfreezeTask } from "./lib/actions";
import { own, requireViewer, viewer } from "./lib/auth";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return [];
    const agents = await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50);
    return agents.filter((a) => a.status !== "revoked").map(({ tokenHash, ...a }) => ({ ...a, hasKey: Boolean(tokenHash) }));
  },
});

export const setStatus = mutation({
  args: { agentId: v.id("agents"), status: v.union(v.literal("active"), v.literal("frozen")) },
  handler: async (ctx, { agentId, status }) => {
    const user = await requireViewer(ctx);
    const agent = await own(user, await ctx.db.get(agentId));
    if (agent.status === "revoked") throw new Error("Agent was revoked");
    const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    const onchain = wallet?.status === "live" && agent.chainAddress;
    if (status === "frozen") {
      await ctx.db.patch(agentId, { status });
      if (onchain) await ctx.scheduler.runAfter(0, internal.chain.guardianFreeze, { walletId: wallet._id, agentAddress: agent.chainAddress });
    } else if (onchain) {
      // Loosening needs the passkey. The agent stays frozen until the vault confirms.
      const taskId = await unfreezeTask(ctx, user, agent);
      return (await ctx.db.get(taskId))?.approvalToken ?? null;
    } else {
      await ctx.db.patch(agentId, { status });
    }
    await ctx.db.insert("activity", {
      userId: user._id,
      kind: "agent",
      title: `${agent.name} ${status === "frozen" ? "frozen" : "unfrozen"}`,
      tone: status === "frozen" ? "warn" : "neutral",
    });
    return null;
  },
});

export const freezeAll = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireViewer(ctx);
    const agents = await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50);
    const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    let count = 0;
    for (const a of agents) {
      if (a.status !== "active") continue;
      await ctx.db.patch(a._id, { status: "frozen" });
      if (wallet?.status === "live" && a.chainAddress) {
        await ctx.scheduler.runAfter(0, internal.chain.guardianFreeze, { walletId: wallet._id, agentAddress: a.chainAddress });
      }
      count++;
    }
    await ctx.db.insert("activity", {
      userId: user._id,
      kind: "security",
      title: `Froze ${count} ${count === 1 ? "agent" : "agents"}`,
      tone: "warn",
    });
    return count;
  },
});

/** Midnight in India (18:30 UTC). Per-agent daily allowances start again. */
export const resetDaily = internalMutation({
  args: {},
  handler: async (ctx) => {
    const agents = await ctx.db.query("agents").take(5000);
    for (const a of agents) if (a.spentTodayMinor > 0) await ctx.db.patch(a._id, { spentTodayMinor: 0 });
  },
});
