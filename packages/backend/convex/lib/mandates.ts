import { Op, cartMandate, contactIdOf, intentMandate, isVaultVersion, paymentMandate, toTokenUnits, type CartMandate, type Contact, type IntentMandate, type PaymentMandate } from "@agent-wallet/domain";
import { decodeAbiParameters, type Address, type Hex } from "viem";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { payeeAddress } from "./actions";

/**
 * AP2 mandates built from what the backend recorded about the vault. Every field they assert is
 * re-checked against the chain by `verifyIntent` / `verifyPayment` / `verifyCart` in the domain
 * package; nothing here is trusted by a verifier.
 */

const isHash = (h?: string): h is Hex => Boolean(h && /^0x[0-9a-fA-F]{64}$/.test(h));

async function contactsOf(ctx: QueryCtx, userId: Doc<"users">["_id"]): Promise<Contact[]> {
  const payees = await ctx.db.query("payees").withIndex("by_user", (q) => q.eq("userId", userId)).take(200);
  return payees
    .filter((p) => p.onchain && p.trusted && !(p.holdUntil && p.holdUntil > Date.now()))
    .map((p) => ({ name: p.name, address: payeeAddress(p), contactId: contactIdOf(p._id) }));
}

/** The approval that put this agent's current grant in the vault, newest first. */
async function grantTask(ctx: QueryCtx, agent: Doc<"agents">) {
  const tasks = await ctx.db
    .query("tasks")
    .withIndex("by_user_updated", (q) => q.eq("userId", agent.userId))
    .order("desc")
    .take(300);
  return tasks.find(
    (t) => t.state === "confirmed" && isHash(t.txHash) && (t.effects?.grant?.agentId === agent._id || t.effects?.agents?.includes(agent._id)),
  );
}

/** What this assistant may do, as an AP2 IntentMandate the vault enforces. Null until its grant is on-chain. */
export async function intentFor(ctx: QueryCtx, agent: Doc<"agents">): Promise<IntentMandate | null> {
  const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", agent.userId)).unique();
  const v = wallet?.vault;
  const g = agent.vault;
  if (!wallet?.address || wallet.status !== "live" || !isVaultVersion(wallet.version) || !v || !g?.active || !agent.chainAddress) return null;
  const task = await grantTask(ctx, agent);
  if (!task) return null;
  return intentMandate({
    vault: wallet.address as Address,
    agent: agent.chainAddress as Address,
    agentName: agent.name,
    perPayment: toTokenUnits(g.perPaymentMinor),
    dailyCap: toTokenUnits(g.dailyCapMinor),
    expiresAt: BigInt(Math.floor(g.expiresAt / 1000)),
    ceiling: toTokenUnits(v.ceilingMinor),
    protectedAmount: toTokenUnits(v.protectedMinor),
    holdAbove: toTokenUnits(v.holdAboveMinor),
    holdFor: v.holdFor,
    contacts: await contactsOf(ctx, agent.userId),
    // A loosening's passkey signature is in the transaction that queued it; the verifier finds it either way.
    signedTx: (isHash(task.priorTxHash) ? task.priorTxHash : task.txHash) as Hex,
    appliedTx: task.txHash as Hex,
  });
}

/** An agent payment the vault settled, as an AP2 PaymentMandate under the agent's intent mandate. */
export async function paymentFor(ctx: QueryCtx, task: Doc<"tasks">, agent: Doc<"agents">, intent: IntentMandate): Promise<PaymentMandate | null> {
  if (task.state !== "confirmed" || task.rail !== "base-sepolia" || !isHash(task.paymentId) || !isHash(task.txHash) || !task.payeeId || !agent.chainAddress) return null;
  const payee = await ctx.db.get(task.payeeId);
  if (!payee) return null;
  // A held payment keeps the hold's transaction; the release is the one that moved the money.
  const held = isHash(task.priorTxHash);
  return paymentMandate({
    vault: intent["x-policyvault"].vault,
    agent: agent.chainAddress as Address,
    paymentId: task.paymentId,
    amount: toTokenUnits(task.amountMinor ?? 0),
    payee: { name: payee.name, address: payeeAddress(payee), contactId: contactIdOf(payee._id) },
    label: task.title,
    tx: (held ? task.priorTxHash : task.txHash) as Hex,
    releaseTx: held ? (task.txHash as Hex) : undefined,
    held,
    timestamp: BigInt(Math.floor(task.updatedAt / 1000)),
    intent,
  });
}

/** A payment the owner approved exactly with their passkey, as an AP2 CartMandate. */
export async function cartFor(ctx: QueryCtx, task: Doc<"tasks">, vault: Address): Promise<CartMandate | null> {
  if (task.state !== "confirmed" || task.action?.op !== Op.Pay || !isHash(task.txHash) || !task.payeeId) return null;
  const payee = await ctx.db.get(task.payeeId);
  if (!payee) return null;
  const [to, amount, paymentId] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes32" }], task.action.data as Hex);
  return cartMandate({
    vault,
    paymentId,
    amount,
    payee: { name: payee.name, address: to, contactId: contactIdOf(payee._id) },
    label: task.title,
    deadline: BigInt(task.action.deadline),
    tx: task.txHash as Hex,
  });
}
