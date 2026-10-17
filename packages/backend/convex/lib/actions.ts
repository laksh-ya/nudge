import { Op, encode, contactIdOf, formatMoney, paymentIdOf, testPayeeAddress, toTokenUnits, type Policy } from "@agent-wallet/domain";
import type { Address, Hex } from "viem";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { newApprovalToken } from "./seed";

const APPROVAL_MINUTES = 30;
const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Rules every new vault gets in its setup approval. The delays are short so a demo can show them
 * end to end; a real deployment would use hours.
 */
export const DEFAULT_RULES = {
  contactDelay: 24 * 3600,
  changeDelay: 120,
  holdAboveMinor: 500,
  holdFor: 120,
};

function nonce() {
  const b = crypto.getRandomValues(new Uint32Array(2));
  return ((BigInt(b[0]!) << 32n) | BigInt(b[1]!)).toString();
}

export function deadline(minutes = APPROVAL_MINUTES) {
  return Math.floor(Date.now() / 1000) + minutes * 60;
}

export function payeeAddress(p: Doc<"payees">): Address {
  return (p.address ?? testPayeeAddress(p.name)) as Address;
}

/** A contact as this vault's version encodes it; v3 adds the contact's daily cap. */
function contactData(p: Doc<"payees">, version: number | undefined, dailyCapMinor = p.dailyCapMinor) {
  return encode.addContact(contactIdOf(p._id), payeeAddress(p), p.trusted, { version, dailyCap: toTokenUnits(dailyCapMinor ?? 0) });
}

type Effects = NonNullable<Doc<"tasks">["effects"]>;

/** Anything the owner signs with their passkey: one exact vault action, one approval link. */
async function ownerTask(
  ctx: MutationCtx,
  user: Doc<"users">,
  t: {
    title: string;
    reason: string;
    op: Op;
    data: Hex;
    agentId?: Id<"agents">;
    effects?: Partial<Effects>;
    minutes?: number;
  },
) {
  const token = newApprovalToken();
  const minutes = t.minutes ?? APPROVAL_MINUTES;
  const taskId = await ctx.db.insert("tasks", {
    userId: user._id,
    title: t.title,
    channel: "app",
    agentId: t.agentId,
    state: "awaiting_approval",
    reason: t.reason,
    rail: "base-sepolia",
    approvalToken: token,
    expiresAt: Date.now() + minutes * 60_000,
    updatedAt: Date.now(),
    action: { op: t.op, data: t.data, nonce: nonce(), deadline: deadline(minutes) },
    effects: t.effects ? { agents: [], payees: [], ...t.effects } : undefined,
  });
  return { taskId, token };
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
    requestId?: string;
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
    requestId: args.requestId,
  });
  const paymentId = paymentIdFor(taskId, args.agentId, args.requestId);
  await ctx.db.patch(taskId, {
    paymentId,
    action: {
      op: Op.Pay,
      data: encode.pay(payeeAddress(args.payee), toTokenUnits(args.amountMinor), paymentId),
      nonce: nonce(),
      deadline: deadline(),
    },
  });
  return { taskId, token };
}

/**
 * The id the vault uses to refuse a second payment. With a caller-supplied request id (an invoice
 * number), retries of the same request map to the same id however many tasks they create.
 */
export function paymentIdFor(taskId: Id<"tasks">, agentId?: Id<"agents">, requestId?: string): Hex {
  return requestId && agentId ? paymentIdOf(`${agentId}:${requestId}`) : paymentIdOf(taskId);
}

function policyOf(wallet: Doc<"wallets">, next?: { protectedMinor?: number; dailyCeilingMinor?: number; holdAboveMinor?: number; holdFor?: number }): Policy {
  const v = wallet.vault;
  return {
    protectedAmount: toTokenUnits(next?.protectedMinor ?? wallet.protectedMinor),
    dailyCeiling: toTokenUnits(next?.dailyCeilingMinor ?? wallet.dailyCeilingMinor),
    newContactDelay: BigInt(v?.contactDelay ?? DEFAULT_RULES.contactDelay),
    changeDelay: BigInt(v && v.changeDelay > 0 ? v.changeDelay : DEFAULT_RULES.changeDelay),
    holdAbove: toTokenUnits(next?.holdAboveMinor ?? (v && v.holdFor > 0 ? v.holdAboveMinor : DEFAULT_RULES.holdAboveMinor)),
    holdFor: BigInt(next?.holdFor ?? (v && v.holdFor > 0 ? v.holdFor : DEFAULT_RULES.holdFor)),
  };
}

function setAgentData(a: { chainAddress?: string }, perPaymentMinor: number, dailyCapMinor: number, expiresAt: number) {
  return encode.setAgent(a.chainAddress as Address, toTokenUnits(perPaymentMinor), toTokenUnits(Math.max(dailyCapMinor, perPaymentMinor)), BigInt(Math.floor(expiresAt / 1000)));
}

/**
 * One approval that registers agents (with their limits) and contacts in the vault. On a new vault
 * it also sets the delay and hold rules last, so this first setup applies at once and every later
 * loosening waits.
 */
export async function setupTask(
  ctx: MutationCtx,
  user: Doc<"users">,
  agents: Doc<"agents">[],
  payees: Doc<"payees">[],
  title: string,
  wallet?: Doc<"wallets"> | null,
  /** The vault's contract version, when `wallet` is left out to skip the policy step. */
  version = wallet?.version,
) {
  const items: { op: Op; data: Hex }[] = [
    ...agents.map((a) => ({ op: Op.SetAgent, data: setAgentData(a, a.perPaymentMinor, a.dailyCapMinor, a.expiresAt) })),
    ...payees.map((p) => ({ op: Op.AddContact, data: contactData(p, version) })),
  ];
  const firstSetup = wallet && (!wallet.vault || wallet.vault.changeDelay === 0);
  if (wallet && firstSetup) items.push({ op: Op.SetPolicy, data: encode.setPolicy(policyOf(wallet)) });
  if (items.length === 0) return null;
  const one = items.length === 1;
  return await ownerTask(ctx, user, {
    title,
    reason: firstSetup
      ? "Agents, contacts and your wallet's safety rules take effect only after your passkey approves them"
      : "Agents and contacts take effect in the vault only after your passkey approves them",
    op: one ? items[0]!.op : Op.Batch,
    data: one ? items[0]!.data : encode.batch(items),
    effects: { agents: agents.map((a) => a._id), payees: payees.map((p) => p._id), policy: firstSetup || undefined },
    minutes: 24 * 60,
  });
}

/** New wallet limits. Lowering applies when signed; raising waits out the vault's delay. */
export async function policyTask(ctx: MutationCtx, user: Doc<"users">, wallet: Doc<"wallets">, next: { protectedMinor: number; dailyCeilingMinor: number }) {
  return await ownerTask(ctx, user, {
    title: "Change wallet limits",
    reason: "The vault enforces these limits, so changing them needs your passkey",
    op: Op.SetPolicy,
    data: encode.setPolicy(policyOf(wallet, next)),
    effects: { policy: true },
  });
}

/**
 * Extra protection: every assistant payment is held, for longer, so the owner or a guardian can stop
 * it. Holding more and for longer only tightens, so it applies as soon as the passkey signs.
 */
export async function protectMoreTask(ctx: MutationCtx, user: Doc<"users">, wallet: Doc<"wallets">, holdSeconds: number) {
  const current = wallet.vault?.holdFor ?? DEFAULT_RULES.holdFor;
  return await ownerTask(ctx, user, {
    title: `Hold every assistant payment for ${Math.round(holdSeconds / 60)} minutes`,
    reason: "Gives you and your guardian time to stop a payment before it leaves",
    op: Op.SetPolicy,
    data: encode.setPolicy(policyOf(wallet, { holdAboveMinor: 0, holdFor: Math.max(holdSeconds, current) })),
    effects: { policy: true },
  });
}

/** New limits for one agent's key. */
export async function grantTask(
  ctx: MutationCtx,
  user: Doc<"users">,
  agent: Doc<"agents">,
  next: { perPaymentMinor: number; dailyCapMinor: number; expiresAt: number; scopes?: string[] },
) {
  return await ownerTask(ctx, user, {
    title: `Change ${agent.name}'s limits`,
    reason: "The vault enforces each agent's limits, so changing them needs your passkey",
    op: Op.SetAgent,
    data: setAgentData(agent, next.perPaymentMinor, next.dailyCapMinor, next.expiresAt),
    agentId: agent._id,
    effects: { grant: { agentId: agent._id, ...next } },
  });
}

/**
 * A new daily cap for one contact (v3 vaults). Same address, so the contact keeps any waiting
 * period it already served. Lowering applies when signed; raising or removing waits.
 */
export async function contactCapTask(ctx: MutationCtx, user: Doc<"users">, payee: Doc<"payees">, wallet: Doc<"wallets">, dailyCapMinor: number) {
  return await ownerTask(ctx, user, {
    title: dailyCapMinor ? `Limit ${payee.name} to ${formatMoney(dailyCapMinor, "USDC")} a day` : `Remove ${payee.name}'s daily limit`,
    reason: "The vault enforces each contact's limit, so changing it needs your passkey",
    op: Op.AddContact,
    data: contactData(payee, wallet.version, dailyCapMinor),
    effects: { contactCap: { payeeId: payee._id, dailyCapMinor } },
  });
}

/** Take an agent's key out of the vault for good. Its history stays. */
export async function removeAgentTask(ctx: MutationCtx, user: Doc<"users">, agent: Doc<"agents">) {
  return await ownerTask(ctx, user, {
    title: `Remove ${agent.name} from the vault`,
    reason: "Its key is frozen already; removing it means it can never be unfrozen",
    op: Op.RemoveAgent,
    data: encode.removeAgent(agent.chainAddress as Address),
    agentId: agent._id,
    effects: { removeAgent: agent._id },
  });
}

export async function unfreezeTask(ctx: MutationCtx, user: Doc<"users">, agent: Doc<"agents"> | null) {
  const { taskId } = await ownerTask(ctx, user, {
    title: agent ? `Unfreeze ${agent.name}` : "Unfreeze the wallet",
    reason: "Unfreezing loosens control, so it needs your passkey and then waits out the vault's delay",
    op: Op.Unfreeze,
    data: encode.unfreeze((agent?.chainAddress ?? ZERO) as Address),
    agentId: agent?._id,
  });
  return taskId;
}

/** A second passkey that can approve everything the first can. The existing passkey signs it. */
export async function addKeyTask(ctx: MutationCtx, user: Doc<"users">, key: { keyId: string; x: string; y: string; rpIdHash: Hex; label: string }) {
  return await ownerTask(ctx, user, {
    title: `Add backup passkey (${key.label})`,
    reason: "A new passkey can approve anything, so your current one must agree, then the vault waits",
    op: Op.AddOwnerKey,
    data: encode.addOwnerKey(key.x as Hex, key.y as Hex, key.rpIdHash),
    effects: { passkey: key.keyId },
  });
}
