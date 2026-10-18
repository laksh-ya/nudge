import { v, ConvexError } from "convex/values";
import { convert, formatMoney, isVaultVersion } from "@agent-wallet/domain";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { DEFAULT_RULES, policyTask, unfreezeTask } from "./lib/actions";
import { relayer } from "./lib/relayer";
import { requireViewer, viewer } from "./lib/auth";
import { hit } from "./lib/limits";
import { latestRates } from "./rates";

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

/** Accounts that can fund the wallet: money you hold, not a loan or a transfer service (#116). */
const FUNDING_KINDS = new Set(["bank", "card", "crypto", "cash"]);
/** The most one top-up moves, and in a day: test money, but the same habits as real money. */
const TOPUP_MAX_MINOR = 50_000;

/**
 * Top the Nudge wallet up from one of your connected sources: the one wallet agents and you pay from
 * (#116). The source's balance goes down by the converted amount; the wallet goes up in test dollars.
 * On an on-chain vault the test tokens are minted into the vault itself.
 */
export const topUp = mutation({
  args: { accountId: v.id("accounts"), amount: v.number() },
  handler: async (ctx, { accountId, amount }) => {
    const user = await requireViewer(ctx);
    const w = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    if (!w) throw new ConvexError("Set up your Nudge wallet first");
    const acct = await ctx.db.get(accountId);
    if (!acct || acct.userId !== user._id) throw new ConvexError("Account not found");
    if (!FUNDING_KINDS.has(acct.kind)) throw new ConvexError("Top up from a bank account, card, crypto wallet or cash");
    const minor = Math.round(amount * 100);
    if (!Number.isFinite(amount) || minor < 100 || minor > TOPUP_MAX_MINOR) throw new ConvexError("Top up between $1 and $500 at a time");
    // Test money, real habits: at most 5 top-ups (so $2,500) a day.
    await hit(ctx, `topup:${user._id}`, 5, 86_400_000, "That's 5 top-ups today. Try again tomorrow.");
    const rates = await latestRates(ctx);
    let cost: number;
    try {
      cost = acct.currency === "USD" || acct.currency === "USDC" ? minor : convert(minor, "USD", acct.currency, rates.fiat);
    } catch {
      throw new ConvexError(`No exchange rate for ${acct.currency} today; pick another source`);
    }
    if (acct.kind !== "card" && acct.balanceMinor < cost) throw new ConvexError(`${acct.name} has ${formatMoney(acct.balanceMinor, acct.currency)}; that's not enough`);
    await ctx.db.patch(acct._id, { balanceMinor: acct.balanceMinor - cost });
    const live = w.status === "live" && isVaultVersion(w.version);
    if (live) await relayer.enqueueAction(ctx, internal.chain.topUpVault, { walletId: w._id, amountMinor: minor });
    else await ctx.db.patch(w._id, { balanceMinor: w.balanceMinor + minor });
    await ctx.db.insert("activity", {
      userId: user._id,
      kind: "payment",
      title: `Topped up the wallet from ${acct.name}`,
      detail: `$${(minor / 100).toFixed(2)} test dollars${acct.currency === "USD" || acct.currency === "USDC" ? "" : `, ${formatMoney(cost, acct.currency)} from ${acct.name}`}${live ? ", minted into your vault" : ""}`,
      tone: "good",
    });
    return { amountMinor: minor, costMinor: cost, currency: acct.currency };
  },
});
