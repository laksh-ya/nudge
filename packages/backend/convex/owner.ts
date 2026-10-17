import { ConvexError, v } from "convex/values";
import { formatMoney, isVaultVersion } from "@agent-wallet/domain";
import { getAddress, isAddress, zeroAddress } from "viem";
import { mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { own, requireViewer } from "./lib/auth";
import { ownerPayTask, withdrawTask } from "./lib/actions";
import { hit } from "./lib/limits";

/**
 * Money the owner moves themselves from the Wallet screen (#11). Nothing moves here: each call only
 * prepares the exact action, and the owner's passkey signs it on the approval page.
 */

/** $10,000 in cents: far above any test balance, low enough to catch a slipped digit. */
const MAX_MINOR = 1_000_000;

async function liveVault(ctx: MutationCtx, user: Doc<"users">) {
  const w = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
  if (!w || w.status !== "live" || !w.address) throw new ConvexError("Your wallet isn't on-chain yet. Create your passkey on the Wallet screen first.");
  if (!isVaultVersion(w.version)) throw new ConvexError("Move to the current vault first (Wallet screen)");
  return w;
}

function checkAmount(amountMinor: number, available: number | undefined, what: string) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new ConvexError("Enter an amount above $0");
  if (amountMinor > MAX_MINOR) throw new ConvexError(`That's more than ${formatMoney(MAX_MINOR, "USDC")}. Check the amount.`);
  if (available !== undefined && amountMinor > available) {
    throw new ConvexError(`Only ${formatMoney(available, "USDC", { cents: true })} can ${what} right now`);
  }
}

export const pay = mutation({
  args: { payeeId: v.id("payees"), amountMinor: v.number(), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireViewer(ctx);
    await hit(ctx, `owner-move:${user._id}`, 10, 60_000);
    const payee = await own(user, await ctx.db.get(args.payeeId));
    if (!payee.address) throw new ConvexError(`${payee.name} has no wallet address to pay`);
    const w = await liveVault(ctx, user);
    // An approved payment still leaves the protected amount in the vault; only Withdraw goes below it.
    const free = w.vault ? Math.max(0, w.vault.balanceMinor - w.vault.heldMinor - w.vault.protectedMinor) : undefined;
    checkAmount(args.amountMinor, free, "be paid without going below your protected amount");
    const purpose = args.note?.trim().slice(0, 140) || undefined;
    const { token } = await ownerPayTask(ctx, {
      user,
      payee,
      amountMinor: args.amountMinor,
      title: `Pay ${payee.name} ${formatMoney(args.amountMinor, "USDC", { cents: true })}`,
      channel: "app",
      purpose,
      reason: payee.onchain ? "You're paying a saved contact from your agent wallet" : `${payee.name} isn't in your vault yet, so after your passkey this waits the vault's change delay and can be cancelled`,
    });
    return token;
  },
});

export const withdraw = mutation({
  args: { to: v.string(), amountMinor: v.number() },
  handler: async (ctx, args) => {
    const user = await requireViewer(ctx);
    await hit(ctx, `owner-move:${user._id}`, 10, 60_000);
    const raw = args.to.trim();
    if (!isAddress(raw, { strict: false })) throw new ConvexError("That isn't a wallet address. It starts with 0x followed by 40 letters and digits.");
    if (raw !== raw.toLowerCase() && raw.slice(2) !== raw.slice(2).toUpperCase() && !isAddress(raw)) {
      throw new ConvexError("That address's capital letters don't match its checksum. Copy it again.");
    }
    const to = getAddress(raw);
    if (to === zeroAddress) throw new ConvexError("That address can't receive payments");
    const w = await liveVault(ctx, user);
    if (to.toLowerCase() === w.address!.toLowerCase()) throw new ConvexError("That's this vault's own address");
    const free = w.vault ? Math.max(0, w.vault.balanceMinor - w.vault.heldMinor) : undefined;
    checkAmount(args.amountMinor, free, "be withdrawn");
    const { token } = await withdrawTask(ctx, user, w, to, args.amountMinor);
    return token;
  },
});
