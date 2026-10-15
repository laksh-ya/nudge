import { Op, encode, contactIdOf, paymentIdOf, testPayeeAddress, toTokenUnits } from "@agent-wallet/domain";
import type { Address } from "viem";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { newApprovalToken } from "./seed";

const APPROVAL_MINUTES = 30;

function nonce() {
  const b = crypto.getRandomValues(new Uint32Array(2));
  return ((BigInt(b[0]!) << 32n) | BigInt(b[1]!)).toString();
}

export function deadline() {
  return Math.floor(Date.now() / 1000) + APPROVAL_MINUTES * 60;
}

export function payeeAddress(p: Doc<"payees">): Address {
  return (p.address ?? testPayeeAddress(p.name)) as Address;
}

/** A payment the owner approves with their passkey; the vault pays the payee directly. */
export async function ownerPayTask(
  ctx: MutationCtx,
  args: {
    user: Doc<"users">;
    payee: Doc<"payees">;
    amountMinor: number;
    title: string;
    channel: Doc<"tasks">["channel"];
    agentId?: Id<"agents">;
    purpose?: string;
    reason: string;
  },
) {
  const token = newApprovalToken();
  const taskId = await ctx.db.insert("tasks", {
    userId: args.user._id,
    title: args.title,
    channel: args.channel,
    agentId: args.agentId,
    payeeId: args.payee._id,
    amountMinor: args.amountMinor,
    currency: "USDC",
    purpose: args.purpose,
    state: "awaiting_approval",
    reason: args.reason,
    rail: "base-sepolia",
    approvalToken: token,
    expiresAt: Date.now() + APPROVAL_MINUTES * 60_000,
    updatedAt: Date.now(),
  });
  await ctx.db.patch(taskId, {
    action: {
      op: Op.Pay,
      data: encode.pay(payeeAddress(args.payee), toTokenUnits(args.amountMinor), paymentIdOf(taskId)),
      nonce: nonce(),
      deadline: deadline(),
    },
  });
  return { taskId, token };
}

/** One approval that registers agents (with their limits) and contacts in the vault. */
export async function setupTask(
  ctx: MutationCtx,
  user: Doc<"users">,
  agents: Doc<"agents">[],
  payees: Doc<"payees">[],
  title: string,
) {
  const items = [
    ...agents.map((a) => ({
      op: Op.SetAgent,
      data: encode.setAgent(
        a.chainAddress as Address,
        toTokenUnits(a.perPaymentMinor),
        toTokenUnits(Math.max(a.dailyCapMinor, a.perPaymentMinor)),
        BigInt(Math.floor(a.expiresAt / 1000)),
      ),
    })),
    ...payees.map((p) => ({ op: Op.AddContact, data: encode.addContact(contactIdOf(p._id), payeeAddress(p), p.trusted) })),
  ];
  if (items.length === 0) return null;
  const token = newApprovalToken();
  const taskId = await ctx.db.insert("tasks", {
    userId: user._id,
    title,
    channel: "app",
    state: "awaiting_approval",
    reason: "Agents and contacts take effect in the vault only after your passkey approves them",
    rail: "base-sepolia",
    approvalToken: token,
    expiresAt: Date.now() + 24 * 3600_000,
    updatedAt: Date.now(),
    action:
      items.length === 1
        ? { op: items[0]!.op, data: items[0]!.data, nonce: nonce(), deadline: Math.floor(Date.now() / 1000) + 24 * 3600 }
        : { op: Op.Batch, data: encode.batch(items), nonce: nonce(), deadline: Math.floor(Date.now() / 1000) + 24 * 3600 },
    effects: { agents: agents.map((a) => a._id), payees: payees.map((p) => p._id) },
  });
  return { taskId, token };
}

export async function unfreezeTask(ctx: MutationCtx, user: Doc<"users">, agent: Doc<"agents"> | null) {
  const token = newApprovalToken();
  return await ctx.db.insert("tasks", {
    userId: user._id,
    title: agent ? `Unfreeze ${agent.name}` : "Unfreeze the wallet",
    channel: "app",
    agentId: agent?._id,
    state: "awaiting_approval",
    reason: "Unfreezing loosens control, so it needs your passkey",
    rail: "base-sepolia",
    approvalToken: token,
    expiresAt: Date.now() + APPROVAL_MINUTES * 60_000,
    updatedAt: Date.now(),
    action: {
      op: Op.Unfreeze,
      data: encode.unfreeze((agent?.chainAddress ?? "0x0000000000000000000000000000000000000000") as Address),
      nonce: nonce(),
      deadline: deadline(),
    },
  });
}
