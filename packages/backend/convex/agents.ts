import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { own, requireViewer, viewer } from "./lib/auth";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return [];
    return await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50);
  },
});

export const setStatus = mutation({
  args: { agentId: v.id("agents"), status: v.union(v.literal("active"), v.literal("frozen")) },
  handler: async (ctx, { agentId, status }) => {
    const user = await requireViewer(ctx);
    const agent = await own(user, await ctx.db.get(agentId));
    if (agent.status === "revoked") throw new Error("Agent was revoked");
    await ctx.db.patch(agentId, { status });
    await ctx.db.insert("activity", {
      userId: user._id,
      kind: "agent",
      title: `${agent.name} ${status === "frozen" ? "frozen" : "unfrozen"}`,
      tone: status === "frozen" ? "warn" : "neutral",
    });
  },
});

export const freezeAll = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireViewer(ctx);
    const agents = await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50);
    let count = 0;
    for (const a of agents) {
      if (a.status !== "active") continue;
      await ctx.db.patch(a._id, { status: "frozen" });
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
