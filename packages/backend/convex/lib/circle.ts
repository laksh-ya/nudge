import { formatMoney } from "@agent-wallet/domain";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * Money moving inside a family link. In this prototype both wallets are the app's own ledger when
 * simulated: the owner's Nudge wallet goes down and the member's goes up, and both see it. When the
 * owner's wallet is on-chain the payment is an ordinary passkey-approved vault payment to the
 * member's own vault; this runs once the vault confirms it.
 */

export const month = (at = Date.now()) => new Date(at).toISOString().slice(0, 7);

/** The link's usage, reset when a new month starts. */
export function usedThisMonth(link: Doc<"familyLinks">) {
  return link.month === month() ? link.usedMinor : 0;
}

export async function walletOf(ctx: MutationCtx, userId: Id<"users">) {
  return await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
}

/** Credit the member and record the payment on both sides. The owner's side is already debited by the caller or the vault. */
export async function credit(ctx: MutationCtx, link: Doc<"familyLinks">, ask: Doc<"familyAsks">, opts: { debitOwner: boolean }) {
  const owner = await ctx.db.get(link.ownerId);
  if (opts.debitOwner) {
    const w = await walletOf(ctx, link.ownerId);
    if (w && w.status !== "live") await ctx.db.patch(w._id, { balanceMinor: w.balanceMinor - ask.amountMinor });
  }
  if (link.memberId) {
    const mw = await walletOf(ctx, link.memberId);
    if (mw && mw.status !== "live") await ctx.db.patch(mw._id, { balanceMinor: mw.balanceMinor + ask.amountMinor });
    await ctx.db.insert("activity", {
      userId: link.memberId,
      kind: "payment",
      title: `${owner?.name || "Your family"} sent you ${formatMoney(ask.amountMinor, "USDC")}`,
      detail: ask.note,
      tone: "good",
    });
  }
  await ctx.db.patch(link._id, { usedMinor: usedThisMonth(link) + ask.amountMinor, month: month() });
  await ctx.db.patch(ask._id, { state: "paid", decidedAt: Date.now() });
  await ctx.db.insert("activity", {
    userId: link.ownerId,
    kind: "payment",
    title: `Sent ${link.name} ${formatMoney(ask.amountMinor, "USDC")}`,
    detail: `${ask.note}${ask.auto ? " · inside their allowance" : ""}`,
    tone: "neutral",
  });
}

/** Called when a task confirms or ends: settles the family ask it belongs to, if any. */
export async function afterTask(ctx: MutationCtx, task: Doc<"tasks">) {
  if (task.channel !== "family") return;
  const ask = await ctx.db.query("familyAsks").withIndex("by_task", (q) => q.eq("taskId", task._id)).unique();
  if (!ask || ask.state !== "approval") return;
  const link = await ctx.db.get(ask.linkId);
  if (!link) return;
  if (task.state === "confirmed") await credit(ctx, link, ask, { debitOwner: false });
  else if (["cancelled", "expired", "failed"].includes(task.state)) await ctx.db.patch(ask._id, { state: "declined", decidedAt: Date.now() });
}
