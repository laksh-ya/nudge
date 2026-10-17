import { v, ConvexError } from "convex/values";
import { isVaultVersion } from "@agent-wallet/domain";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { unfreezeTask } from "./lib/actions";
import { relayer } from "./lib/relayer";
import { requireViewer, viewer } from "./lib/auth";

export const get = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return null;
    const doc = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    const payees = await ctx.db.query("payees").withIndex("by_user", (q) => q.eq("userId", user._id)).take(200);
    // Setup links, challenges and the passkey confirmation code never go to the browser.
    const wallet = doc ? { ...doc, enrolToken: undefined, enrolChallenge: undefined, candidate: undefined } : null;
    return { wallet, payees };
  },
});

export const setFrozen = mutation({
  args: { frozen: v.boolean() },
  handler: async (ctx, { frozen }) => {
    const user = await requireViewer(ctx);
    const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    if (!wallet) throw new ConvexError("No wallet");
    if (wallet.status === "live" && isVaultVersion(wallet.version)) {
      if (frozen) {
        await ctx.db.patch(wallet._id, { frozen: true });
        await relayer.enqueueAction(ctx, internal.chain.guardianFreeze, { walletId: wallet._id });
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
