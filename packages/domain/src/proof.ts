import { formatUnits, type Address, type Hex } from "viem";
import { REFUSAL } from "./vault";

/**
 * What the proof page shows, worked out only from the vault's own on-chain events and state.
 * Names (who an address or contact id is) come from the owner's own records and are labelled as such;
 * every amount, code and time comes from the chain.
 */

export type ProofEvent = { eventName: string; args: Record<string, unknown>; transactionHash: Hex; blockNumber: bigint; logIndex: number; address?: Address };

const OP_NAMES = ["a payment", "an agent's limits", "removing an agent", "a contact", "removing a contact", "wallet rules", "an unfreeze", "a new passkey", "removing a passkey", "a withdrawal", "a cancel", "a cancel", "several changes"];
export type ProofLine = { title: string; detail?: string; tone: "good" | "bad" | "warn" | "neutral"; tx: Hex; block: bigint; index: number };
export type Names = { agents: Record<string, string>; contacts: Record<string, string>; addresses: Record<string, string> };

const money = (units: unknown) =>
  `$${Number(formatUnits(BigInt(units as bigint), 6)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const lower = (v: unknown) => String(v).toLowerCase();

export function describeEvent(e: ProofEvent, names: Names): ProofLine {
  const a = e.args;
  const agent = (x: unknown) => names.agents[lower(x)] ?? `agent ${String(x).slice(0, 8)}…`;
  const contact = (x: unknown) => names.contacts[lower(x)] ?? "a contact";
  const address = (x: unknown) => names.addresses[lower(x)] ?? `${String(x).slice(0, 8)}…`;
  const line = (title: string, tone: ProofLine["tone"], detail?: string): ProofLine => ({ title, detail, tone, tx: e.transactionHash, block: e.blockNumber, index: e.logIndex });
  switch (e.eventName) {
    case "PaymentExecuted":
      return line(`${agent(a.agent)} paid ${contact(a.contactId)} ${money(a.amount)}`, "good", "Within its limits");
    case "PaymentRefused": {
      const code = Number(a.code);
      return line(`Refused ${agent(a.agent)}: ${money(a.amount)} to ${contact(a.contactId)}`, "bad", `Code ${code}: ${REFUSAL[code] ?? "refused by the vault"}`);
    }
    case "PaymentHeld":
      return line(`Held ${agent(a.agent)}'s ${money(a.amount)} to ${contact(a.contactId)}`, "warn", `Could leave at ${new Date(Number(a.releaseAt) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC unless cancelled`);
    case "PaymentReleased":
      return line(`Released ${money(a.amount)} to ${address(a.payee)}`, "good", "The hold ended without a cancel");
    case "PaymentCancelled":
      return line("Held payment cancelled", "neutral", "The money never left");
    case "OwnerPaid":
      return line(`You paid ${address(a.to)} ${money(a.amount)}`, "good", "Approved with your passkey");
    case "OwnerAction":
      return line(`Your passkey approved: ${OP_NAMES[Number(a.op)] ?? "a change"}`, "neutral");
    case "AgentSet":
      return line(`${agent(a.agent)} may pay up to ${money(a.perPayment)} each, ${money(a.dailyCap)} per 24 hours`, "neutral", `Until ${new Date(Number(a.expiresAt) * 1000).toISOString().slice(0, 10)}`);
    case "AgentRemoved":
      return line(`${agent(a.agent)} removed from the vault`, "warn");
    case "ContactAdded":
      return line(`Contact added: ${contact(a.contactId)}`, "neutral", `Agents can pay from ${new Date(Number(a.activeAt) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`);
    case "ContactRemoved":
      return line(`Contact removed: ${contact(a.contactId)}`, "warn");
    case "PolicyChanged":
      return line("Wallet rules set", "neutral", `Protected ${money(a.protectedAmount)} · all agents ${money(a.dailyCeiling)} per 24 hours`);
    case "ChangeQueued":
      return line("A loosening change is waiting", "warn", `Applies at ${new Date(Number(a.readyAt) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC unless cancelled`);
    case "ChangeApplied":
      return line("A waiting change applied", "neutral");
    case "ChangeCancelled":
      return line("A waiting change was cancelled", "neutral");
    case "Struck":
      return line(`${agent(a.agent)} refused, strike ${String(a.strikes)} of 5`, "bad", "Five refusals in 24 hours freeze it");
    case "Frozen": {
      const whole = lower(a.agent) === "0x0000000000000000000000000000000000000000";
      const by = lower(a.by) === lower(e.address) ? "after five refusals" : lower(a.by) === lower(a.agent) ? "by its own key" : "by the guardian";
      return line(whole ? "Whole vault frozen" : `${agent(a.agent)} frozen`, "bad", whole ? "By the guardian" : `Frozen ${by}`);
    }
    case "Unfrozen":
      return line(lower(a.agent) === "0x0000000000000000000000000000000000000000" ? "Vault unfrozen" : `${agent(a.agent)} unfrozen`, "neutral", "Needed your passkey and the waiting period");
    case "OwnerKeyAdded":
      return line("Passkey added", "neutral");
    case "OwnerKeyRemoved":
      return line("Passkey removed", "warn");
    case "NewGeneration":
      return line("Older approved changes voided", "neutral", "After a revocation or freeze, waiting changes must be approved again");
    default:
      return line(e.eventName, "neutral");
  }
}

export type VaultState = {
  balance: bigint;
  held: bigint;
  protectedAmount: bigint;
  dailyCeiling: bigint;
  spent24h: bigint;
  frozen: boolean;
};

export type Exposure = {
  /** What agents together could still send now. */
  now: bigint;
  /** Promised to held payments, not yet gone. */
  committed: bigint;
  /** The most agents together can move in any 24 hours, whatever happens. */
  bound24h: bigint;
  assumptions: string[];
};

const min = (...xs: bigint[]) => xs.reduce((m, x) => (x < m ? x : m));
const pos = (x: bigint) => (x > 0n ? x : 0n);

/** The vault's own numbers, read from the chain, turned into a worst case. */
export function exposure(s: VaultState, newGrant?: { dailyCap: bigint }): Exposure {
  const free = pos(s.balance - s.held);
  const aboveProtected = pos(free - s.protectedAmount);
  const now = s.frozen ? 0n : min(pos(s.dailyCeiling - s.spent24h), aboveProtected);
  const bound = s.frozen ? 0n : min(s.dailyCeiling, pos(s.balance - s.protectedAmount));
  return {
    now: newGrant ? min(now, newGrant.dailyCap) : now,
    committed: s.held,
    bound24h: newGrant ? min(bound, newGrant.dailyCap) : bound,
    assumptions: [
      "Agents' payments in any rolling 24 hours never exceed the vault's ceiling, counted from when money leaves",
      "Agents can never spend below the protected amount",
      "Only your passkey can loosen these rules, and loosening waits before it applies",
      "Your passkeys are not compromised; a stolen agent key is covered",
    ],
  };
}

export const contactLabels = (contacts: { id: Hex; name: string }[]) => Object.fromEntries(contacts.map((c) => [c.id.toLowerCase(), c.name]));
export const addressLabels = (rows: { address?: string | null; name: string }[]) =>
  Object.fromEntries(rows.filter((r) => r.address).map((r) => [(r.address as Address).toLowerCase(), r.name]));
