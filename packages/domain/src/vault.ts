import {
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  keccak256,
  size,
  slice,
  toBytes,
  toHex,
  type Address,
  type Hex,
} from "viem";

/**
 * Everything the app, the approval site and the backend must agree on byte for byte.
 * The approval site recomputes the digest from the decoded fields it shows; it never
 * trusts a challenge handed to it by the server.
 */

export const CHAIN_ID = 84532; // Base Sepolia
export const EXPLORER = "https://sepolia.basescan.org";
export const TOKEN_DECIMALS = 6; // tUSD and USDC
/** The PolicyVault version the current factory deploys. Older vaults keep their own encodings. */
export const VAULT_VERSION = 3;
/** A vault the app treats as on-chain (v2 or later); v1 vaults only offer the upgrade. */
export const isVaultVersion = (version?: number | null) => (version ?? 0) >= 2;
const MINOR_TO_TOKEN = 10n ** BigInt(TOKEN_DECIMALS - 2);

export enum Op {
  Pay = 0,
  SetAgent = 1,
  RemoveAgent = 2,
  AddContact = 3,
  RemoveContact = 4,
  SetPolicy = 5,
  Unfreeze = 6,
  AddOwnerKey = 7,
  RemoveOwnerKey = 8,
  Withdraw = 9,
  CancelChange = 10,
  CancelHeld = 11,
  Batch = 12,
}

/** Wallet-wide rules. Delays are seconds; amounts are token units. */
export type Policy = {
  protectedAmount: bigint;
  dailyCeiling: bigint;
  newContactDelay: bigint;
  changeDelay: bigint;
  holdAbove: bigint;
  holdFor: bigint;
};

export const ACTION_TYPEHASH = keccak256(toBytes("Action(uint8 op,bytes data,uint256 nonce,uint64 deadline,uint256 chainId,address vault)"));

export type Action = { op: Op; data: Hex; nonce: bigint; deadline: bigint };

export function actionDigest(action: Action, vault: Address, chainId = CHAIN_ID): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint8" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint64" }, { type: "uint256" }, { type: "address" }],
      [ACTION_TYPEHASH, action.op, keccak256(action.data), action.nonce, action.deadline, BigInt(chainId), vault],
    ),
  );
}

/** Cents (minor units of USD) to token base units (6 decimals). */
export function toTokenUnits(minor: number): bigint {
  return BigInt(minor) * MINOR_TO_TOKEN;
}

export function fromTokenUnits(units: bigint): number {
  return Number(units / MINOR_TO_TOKEN);
}

/** Same as PolicyVault.keyIdOf: the id the vault stores a passkey under. */
export function keyIdOf(x: Hex, y: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [x, y]));
}

export function contactIdOf(payeeId: string): Hex {
  return keccak256(toBytes(`contact:${payeeId}`));
}

export function paymentIdOf(taskId: string): Hex {
  return keccak256(toBytes(`payment:${taskId}`));
}

/** A stable, clearly fake address for demo merchants on the test network. */
export function testPayeeAddress(name: string): Address {
  return getAddress(slice(keccak256(toBytes(`agent-wallet test payee:${name.toLowerCase()}`)), 12));
}

const POLICY = [{ type: "uint256" }, { type: "uint256" }, { type: "uint64" }, { type: "uint64" }, { type: "uint256" }, { type: "uint64" }] as const;

/** Same as PolicyVault.changeIdOf: the id a queued owner action waits under. */
export function changeIdOf(op: Op, data: Hex, nonce: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }, { type: "uint256" }], [op, keccak256(data), nonce]));
}

export const encode = {
  pay: (to: Address, amount: bigint, paymentId: Hex) =>
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes32" }], [to, amount, paymentId]),
  setAgent: (agent: Address, perPayment: bigint, dailyCap: bigint, expiresAt: bigint) =>
    encodeAbiParameters([{ type: "address" }, { type: "uint128" }, { type: "uint128" }, { type: "uint64" }], [agent, perPayment, dailyCap, expiresAt]),
  removeAgent: (agent: Address) => encodeAbiParameters([{ type: "address" }], [agent]),
  /** v3 vaults also take a per-contact cap for all agents together, per 24 hours (0 = none). */
  addContact: (contactId: Hex, payee: Address, immediate: boolean, opts: { dailyCap?: bigint; version?: number } = {}) =>
    (opts.version ?? VAULT_VERSION) >= 3
      ? encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "bool" }, { type: "uint128" }], [contactId, payee, immediate, opts.dailyCap ?? 0n])
      : encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "bool" }], [contactId, payee, immediate]),
  setPolicy: (p: Policy) =>
    encodeAbiParameters(POLICY, [p.protectedAmount, p.dailyCeiling, p.newContactDelay, p.changeDelay, p.holdAbove, p.holdFor]),
  unfreeze: (agent: Address) => encodeAbiParameters([{ type: "address" }], [agent]),
  withdraw: (to: Address, amount: bigint) => encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [to, amount]),
  addOwnerKey: (x: Hex, y: Hex, rpIdHash: Hex) =>
    encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], [x, y, rpIdHash]),
  removeOwnerKey: (keyId: Hex) => encodeAbiParameters([{ type: "bytes32" }], [keyId]),
  cancelChange: (changeId: Hex) => encodeAbiParameters([{ type: "bytes32" }], [changeId]),
  cancelHeld: (paymentId: Hex) => encodeAbiParameters([{ type: "bytes32" }], [paymentId]),
  batch: (items: { op: Op; data: Hex }[]) =>
    encodeAbiParameters([{ type: "uint8[]" }, { type: "bytes[]" }], [items.map((i) => i.op), items.map((i) => i.data)]),
};

export type Line = { label: string; value: string; mono?: boolean };

const ZERO = "0x0000000000000000000000000000000000000000";

function money(units: bigint) {
  const cents = Number(units / MINOR_TO_TOKEN);
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function duration(seconds: bigint) {
  const s = Number(seconds);
  if (s === 0) return "No wait";
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86_400) return `${+(s / 3600).toFixed(1)} hours`;
  return `${+(s / 86_400).toFixed(1)} days`;
}

function when(seconds: bigint) {
  return new Date(Number(seconds) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Turn the exact bytes being signed back into readable lines. Names (who an address belongs to)
 * come from `names`; everything else comes only from the bytes.
 */
export function describe(op: Op, data: Hex, names: Record<string, string> = {}): { title: string; lines: Line[] } {
  const who = (a: string) => names[a.toLowerCase()] ?? names[a] ?? "";
  switch (op) {
    case Op.Pay: {
      const [to, amount, paymentId] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes32" }], data);
      return {
        title: `Pay ${money(amount)}`,
        lines: [
          { label: "To", value: who(to) || "Address" },
          { label: "Address", value: to, mono: true },
          { label: "Amount", value: `${money(amount)} test dollars` },
          { label: "Payment ID", value: `${paymentId.slice(0, 10)}…`, mono: true },
        ],
      };
    }
    case Op.SetAgent: {
      const [agent, per, cap, exp] = decodeAbiParameters([{ type: "address" }, { type: "uint128" }, { type: "uint128" }, { type: "uint64" }], data);
      return {
        title: `Let ${who(agent) || "an agent"} pay within limits`,
        lines: [
          { label: "Agent", value: who(agent) || agent },
          { label: "Agent key", value: agent, mono: true },
          { label: "Per payment", value: money(per) },
          { label: "Per 24 hours", value: money(cap) },
          { label: "Until", value: when(exp) },
        ],
      };
    }
    case Op.RemoveAgent: {
      const [agent] = decodeAbiParameters([{ type: "address" }], data);
      return { title: `Remove ${who(agent) || "an agent"}`, lines: [{ label: "Agent key", value: agent, mono: true }] };
    }
    case Op.AddContact: {
      // v3 adds a fourth word, the contact's daily cap.
      const v3 = size(data) >= 128;
      const [, payee, immediate, cap] = v3
        ? decodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "bool" }, { type: "uint128" }], data)
        : [...decodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "bool" }], data), undefined];
      return {
        title: `Add ${who(payee) || "a contact"}`,
        lines: [
          { label: "Contact", value: who(payee) || "Unnamed" },
          { label: "Address", value: payee, mono: true },
          { label: "Agents can pay", value: immediate ? "Right away" : "After the waiting period" },
          ...(v3 ? [{ label: "All agents, per 24 hours", value: cap ? money(cap) : "No cap for this contact" }] : []),
        ],
      };
    }
    case Op.SetPolicy: {
      const [protectedAmount, ceiling, contactDelay, changeDelay, holdAbove, holdFor] = decodeAbiParameters(POLICY, data);
      return {
        title: "Change wallet rules",
        lines: [
          { label: "Protected from agents", value: money(protectedAmount) },
          { label: "All agents, per 24 hours", value: money(ceiling) },
          { label: "New contacts wait", value: duration(contactDelay) },
          { label: "Loosening waits", value: duration(changeDelay) },
          { label: "Agent payments held", value: holdFor === 0n ? "Never" : `Above ${money(holdAbove)}, for ${duration(holdFor)}` },
        ],
      };
    }
    case Op.Unfreeze: {
      const [agent] = decodeAbiParameters([{ type: "address" }], data);
      return { title: agent === ZERO ? "Unfreeze the wallet" : `Unfreeze ${who(agent) || "an agent"}`, lines: agent === ZERO ? [] : [{ label: "Agent key", value: agent, mono: true }] };
    }
    case Op.Withdraw: {
      const [to, amount] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], data);
      return {
        title: `Withdraw ${money(amount)}`,
        lines: [
          { label: "To", value: who(to) || "Address" },
          { label: "Address", value: to, mono: true },
          { label: "Protected amount", value: "Can go below it" },
        ],
      };
    }
    case Op.AddOwnerKey: {
      const [x, y, rpIdHash] = decodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], data);
      return {
        title: "Add a backup passkey",
        lines: [
          { label: "Passkey", value: names[keyIdOf(x, y)] || "New passkey" },
          { label: "Key ID", value: keyIdOf(x, y), mono: true },
          { label: "Made for", value: names[rpIdHash] || rpIdHash, mono: !names[rpIdHash] },
          { label: "Can", value: "Approve anything your current passkey can" },
        ],
      };
    }
    case Op.RemoveOwnerKey: {
      const [keyId] = decodeAbiParameters([{ type: "bytes32" }], data);
      return {
        title: "Remove a passkey",
        lines: [
          { label: "Passkey", value: names[keyId] || "Passkey" },
          { label: "Key ID", value: keyId, mono: true },
        ],
      };
    }
    case Op.CancelChange: {
      const [id] = decodeAbiParameters([{ type: "bytes32" }], data);
      return { title: "Cancel a waiting change", lines: [{ label: "Change", value: names[id] || id, mono: !names[id] }] };
    }
    case Op.CancelHeld: {
      const [id] = decodeAbiParameters([{ type: "bytes32" }], data);
      return { title: "Cancel a held payment", lines: [{ label: "Payment", value: names[id] || id, mono: !names[id] }] };
    }
    case Op.Batch: {
      const [ops, datas] = decodeAbiParameters([{ type: "uint8[]" }, { type: "bytes[]" }], data);
      const parts = ops.map((o, i) => describe(o as Op, datas[i]!, names));
      return {
        title: parts.length === 1 ? parts[0]!.title : `${parts.length} changes`,
        lines: parts.flatMap((p) => [{ label: "", value: p.title }, ...p.lines.filter((l) => l.label !== "Payment ID")]),
      };
    }
    default:
      return { title: "Wallet change", lines: [{ label: "Data", value: toHex(toBytes(data)).slice(0, 18), mono: true }] };
  }
}

export const REFUSAL: Record<number, string> = {
  1001: "Not a registered agent",
  1002: "Frozen",
  2001: "The agent's access has expired",
  2002: "New contact, still in the waiting period",
  2003: "Above the agent's limit",
  2004: "Above the wallet's daily ceiling for all agents",
  2005: "Would dip into the protected amount",
  2007: "This payment was already made",
  2009: "Too many payments in 24 hours",
  2010: "Not one of your contacts",
  2012: "Above this contact's limit for all agents in 24 hours",
};
