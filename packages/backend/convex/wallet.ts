import { v, ConvexError } from "convex/values";
import { isVaultVersion } from "@agent-wallet/domain";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { DEFAULT_RULES, policyTask, unfreezeTask } from "./lib/actions";
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

/** Every rule, in one place: what the vault (or the simulated wallet) enforces right now. */
export const rules = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return null;
    const w = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    if (!w) return null;
    const live = w.status === "live" && isVaultVersion(w.version) && Boolean(w.vault);
    const r = live ? w.vault! : (w.rules ?? DEFAULT_RULES);
    const pending = w.proposedPolicy ? { ...w.proposedPolicy } : null;
    return {
      live,
      dailyCeilingMinor: live ? w.vault!.ceilingMinor : w.dailyCeilingMinor,
      protectedMinor: live ? w.vault!.protectedMinor : w.protectedMinor,
      perPaymentMinor: w.perPaymentMinor ?? 0,
      holdAboveMinor: r.holdAboveMinor,
      holdFor: r.holdFor,
      contactDelay: r.contactDelay,
      changeDelay: r.changeDelay,
      pending,
    };
  },
});

const MAX_DELAY = 7 * 86_400;

/**
 * Change any rule. Tightening applies at once; on an on-chain wallet every change is one passkey
 * approval of the vault's own policy, and loosening then waits out the current change delay.
 */
export const setRules = mutation({
  args: {
    dailyCeilingMinor: v.number(),
    protectedMinor: v.number(),
    perPaymentMinor: v.number(),
    holdAboveMinor: v.number(),
    holdFor: v.number(),
    contactDelay: v.number(),
    changeDelay: v.number(),
  },
  handler: async (ctx, a) => {
    const user = await requireViewer(ctx);
    const w = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    if (!w) throw new ConvexError("Set up your Nudge wallet first");
    for (const [k, n] of Object.entries({ dailyCeilingMinor: a.dailyCeilingMinor, protectedMinor: a.protectedMinor, perPaymentMinor: a.perPaymentMinor, holdAboveMinor: a.holdAboveMinor })) {
      if (!Number.isSafeInteger(n) || n < 0 || n > 10_000_000) throw new ConvexError(`${k === "dailyCeilingMinor" ? "The daily limit" : k === "protectedMinor" ? "The protected amount" : k === "perPaymentMinor" ? "The biggest payment" : "The hold amount"} must be between $0 and $100,000`);
    }
    if (a.perPaymentMinor > a.dailyCeilingMinor) throw new ConvexError("The biggest single payment can't be more than the daily limit");
    for (const [label, s, min] of [["The hold time", a.holdFor, 0], ["The new-contact wait", a.contactDelay, 0], ["The wait before loosening", a.changeDelay, 60]] as const) {
      if (!Number.isInteger(s) || s < min || s > MAX_DELAY) throw new ConvexError(`${label} must be ${min ? "1 minute" : "0"} to 7 days`);
    }
    const rules = { holdAboveMinor: a.holdAboveMinor, holdFor: a.holdFor, contactDelay: a.contactDelay, changeDelay: a.changeDelay };
    if (w.status === "live" && isVaultVersion(w.version) && w.vault) {
      const task = await policyTask(ctx, user, w, { protectedMinor: a.protectedMinor, dailyCeilingMinor: a.dailyCeilingMinor, ...rules });
      // Our gateway takes the stricter of old and new at once; the vault changes when signed.
      await ctx.db.patch(w._id, {
        perPaymentMinor: a.perPaymentMinor,
        protectedMinor: Math.max(w.protectedMinor, a.protectedMinor),
        dailyCeilingMinor: Math.min(w.dailyCeilingMinor, a.dailyCeilingMinor),
        proposedPolicy: { dailyCeilingMinor: a.dailyCeilingMinor, protectedMinor: a.protectedMinor, perPaymentMinor: a.perPaymentMinor, taskId: task.taskId },
      });
      return task.token;
    }
    await ctx.db.patch(w._id, { dailyCeilingMinor: a.dailyCeilingMinor, protectedMinor: a.protectedMinor, perPaymentMinor: a.perPaymentMinor, rules });
    await ctx.db.insert("activity", { userId: user._id, kind: "setting", title: "Changed your wallet rules", detail: "Simulated wallet: applied at once", tone: "neutral" });
    return null;
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
