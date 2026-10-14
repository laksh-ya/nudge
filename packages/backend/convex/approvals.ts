import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * The approval link carries an opaque token. Opening it only reads; nothing is
 * consumed until the owner decides. Passkey signing replaces the plain decision next.
 */
export const get = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    if (token.length < 16) return null;
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_approval_token", (q) => q.eq("approvalToken", token))
      .unique();
    if (!task) return null;
    const [user, payee, agent, wallet] = await Promise.all([
      ctx.db.get(task.userId),
      task.payeeId ? ctx.db.get(task.payeeId) : null,
      task.agentId ? ctx.db.get(task.agentId) : null,
      ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", task.userId)).unique(),
    ]);
    return {
      title: task.title,
      state: task.state,
      amountMinor: task.amountMinor ?? 0,
      currency: task.currency ?? "USDC",
      purpose: task.purpose,
      reason: task.reason,
      rail: task.rail,
      channel: task.channel,
      expiresAt: task.expiresAt,
      owner: user?.name,
      payee: payee ? { name: payee.name, handle: payee.handle, trusted: payee.trusted, kind: payee.kind } : null,
      agent: agent?.name,
      wallet: wallet ? { address: wallet.address, balanceMinor: wallet.balanceMinor, chain: wallet.chain } : null,
    };
  },
});

export const decide = mutation({
  args: { token: v.string(), approve: v.boolean() },
  handler: async (ctx, { token, approve }) => {
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_approval_token", (q) => q.eq("approvalToken", token))
      .unique();
    if (!task) throw new Error("This link is no longer valid");
    if (task.state !== "awaiting_approval") return task.state;
    if (task.expiresAt && task.expiresAt < Date.now()) {
      await ctx.db.patch(task._id, { state: "expired", updatedAt: Date.now() });
      return "expired";
    }
    if (!approve) {
      await ctx.db.patch(task._id, { state: "cancelled", updatedAt: Date.now() });
      await ctx.db.insert("activity", { userId: task.userId, kind: "payment", title: `Declined ${task.title}`, tone: "neutral" });
      return "cancelled";
    }
    await ctx.db.patch(task._id, { state: "submitted", updatedAt: Date.now() });
    await ctx.scheduler.runAfter(1600, internal.tasks.settle, { taskId: task._id });
    return "submitted";
  },
});
