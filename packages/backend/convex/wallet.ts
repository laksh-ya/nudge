import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { unfreezeTask } from "./lib/actions";
import { requireViewer, viewer } from "./lib/auth";

export const get = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return null;
    const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    const payees = await ctx.db.query("payees").withIndex("by_user", (q) => q.eq("userId", user._id)).take(200);
    return { wallet, payees };
  },
});

export const setFrozen = mutation({
  args: { frozen: v.boolean() },
  handler: async (ctx, { frozen }) => {
    const user = await requireViewer(ctx);
    const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    if (!wallet) throw new Error("No wallet");
    if (wallet.status === "live") {
      if (frozen) {
        await ctx.db.patch(wallet._id, { frozen: true });
        await ctx.scheduler.runAfter(0, internal.chain.guardianFreeze, { walletId: wallet._id });
      } else {
        const taskId = await unfreezeTask(ctx, user, null);
        return (await ctx.db.get(taskId))?.approvalToken ?? null;
      }
    } else {
      await ctx.db.patch(wallet._id, { frozen });
    }
    await ctx.db.insert("activity", {
      userId: user._id,
      kind: "security",
      title: frozen ? "Wallet frozen" : "Wallet unfrozen",
      detail: frozen ? "No agent can spend until you unfreeze" : undefined,
      tone: frozen ? "warn" : "neutral",
    });
    return null;
  },
});
