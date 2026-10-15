import {
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  keccak256,
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
  Batch = 10,
}

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

export const encode = {
  pay: (to: Address, amount: bigint, paymentId: Hex) =>
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes32" }], [to, amount, paymentId]),
  setAgent: (agent: Address, perPayment: bigint, dailyCap: bigint, expiresAt: bigint) =>
    encodeAbiParameters([{ type: "address" }, { type: "uint128" }, { type: "uint128" }, { type: "uint64" }], [agent, perPayment, dailyCap, expiresAt]),
  removeAgent: (agent: Address) => encodeAbiParameters([{ type: "address" }], [agent]),
  addContact: (contactId: Hex, payee: Address, immediate: boolean) =>
    encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "bool" }], [contactId, payee, immediate]),
  setPolicy: (protectedAmount: bigint, dailyCeiling: bigint, newContactDelay: bigint) =>
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint64" }], [protectedAmount, dailyCeiling, newContactDelay]),
  unfreeze: (agent: Address) => encodeAbiParameters([{ type: "address" }], [agent]),
  withdraw: (to: Address, amount: bigint) => encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [to, amount]),
  batch: (items: { op: Op; data: Hex }[]) =>
    encodeAbiParameters([{ type: "uint8[]" }, { type: "bytes[]" }], [items.map((i) => i.op), items.map((i) => i.data)]),
};

export type Line = { label: string; value: string; mono?: boolean };

const ZERO = "0x0000000000000000000000000000000000000000";

function money(units: bigint) {
  const cents = Number(units / MINOR_TO_TOKEN);
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
      const [, payee, immediate] = decodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "bool" }], data);
      return {
        title: `Add ${who(payee) || "a contact"}`,
        lines: [
          { label: "Contact", value: who(payee) || "Unnamed" },
          { label: "Address", value: payee, mono: true },
          { label: "Agents can pay", value: immediate ? "Right away" : "After the waiting period" },
        ],
      };
    }
    case Op.SetPolicy: {
      const [protectedAmount, ceiling, delay] = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint64" }], data);
      return {
        title: "Change wallet limits",
        lines: [
          { label: "Protected", value: money(protectedAmount) },
          { label: "All agents, per 24 hours", value: money(ceiling) },
          { label: "New contacts wait", value: `${Number(delay) / 3600} hours` },
        ],
      };
    }
    case Op.Unfreeze: {
      const [agent] = decodeAbiParameters([{ type: "address" }], data);
      return { title: agent === ZERO ? "Unfreeze the wallet" : `Unfreeze ${who(agent) || "an agent"}`, lines: agent === ZERO ? [] : [{ label: "Agent key", value: agent, mono: true }] };
    }
    case Op.Withdraw: {
      const [to, amount] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], data);
      return { title: `Withdraw ${money(amount)}`, lines: [{ label: "To", value: to, mono: true }] };
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
};
