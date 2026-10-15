import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { CHAIN_ID, EXPLORER } from "@agent-wallet/domain";

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
    let onchain = null;
    if (task.action && wallet?.address && wallet.keyId) {
      // Names for the addresses that appear in the signed bytes. The bytes themselves are rendered by the page.
      const names: Record<string, string> = {};
      for (const p of await ctx.db.query("payees").withIndex("by_user", (q) => q.eq("userId", task.userId)).take(200)) {
        if (p.address) names[p.address.toLowerCase()] = p.name;
      }
      for (const a of await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", task.userId)).take(50)) {
        if (a.chainAddress) names[a.chainAddress.toLowerCase()] = a.name;
      }
      onchain = {
        action: task.action,
        vault: wallet.address,
        chainId: CHAIN_ID,
        keyId: wallet.keyId,
        credentialId: wallet.credentialId ?? null,
        rpId: wallet.rpId ?? null,
        names,
      };
    }
    return {
      onchain,
      txHash: task.txHash ?? null,
      explorer: EXPLORER,
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
    if (approve && task.action) throw new Error("Approve this with your passkey");
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

/** The passkey signed the exact action. The relayer submits it; the vault checks the signature itself. */
export const submit = mutation({
  args: {
    token: v.string(),
    auth: v.object({
      r: v.string(),
      s: v.string(),
      challengeIndex: v.number(),
      typeIndex: v.number(),
      authenticatorData: v.string(),
      clientDataJSON: v.string(),
    }),
  },
  handler: async (ctx, { token, auth }) => {
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_approval_token", (q) => q.eq("approvalToken", token))
      .unique();
    if (!task?.action) throw new Error("This link is no longer valid");
    if (task.state !== "awaiting_approval") return task.state;
    if (task.action.deadline * 1000 < Date.now()) {
      await ctx.db.patch(task._id, { state: "expired", updatedAt: Date.now() });
      return "expired";
    }
    if (auth.clientDataJSON.length > 2000 || auth.authenticatorData.length > 1000) throw new Error("Signature too large");
    await ctx.db.patch(task._id, { state: "reserved", updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.chain.relayOwner, { taskId: task._id, auth });
    return "reserved";
  },
});
