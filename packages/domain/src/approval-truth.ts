import { decodeAbiParameters, formatUnits, getAddress, type Address, type Hex } from "viem";
import { Op, contactIdOf, describe, fromTokenUnits, type Line } from "./vault";

/**
 * What the approval page may show, worked out only from the bytes the passkey will sign and from
 * the vault's own on-chain records. Anything the server says (amount, payee, names) is checked
 * against those, and a disagreement disables approval. Pure: the page passes in a chain reader.
 */

/** Reads the vault on Base Sepolia from a public RPC, never through our server. */
export type ChainReader = {
  contact(contactId: Hex): Promise<{ payee: Address; activeAt: bigint }>;
};

/** What the server claims about the request. None of it is trusted. */
export type ServerClaims = {
  amountMinor?: number;
  payee?: { name: string; address?: string | null } | null;
  /** Saved contacts the server says the bytes refer to: the id their on-chain record is keyed by. */
  contacts: { payeeId: string; name: string; address?: string | null }[];
  /** Names for other addresses in the bytes (agent keys, new contacts). Shown as unverified. */
  names: Record<string, string>;
};

export type Payee = {
  address: Address;
  /** A saved contact in this vault, confirmed by reading the vault. */
  saved: { name: string; activeAt: number } | null;
};

export type Truth = {
  title: string;
  /** Amount in cents, from the bytes, when the action moves money. */
  amountMinor: number | null;
  payee: Payee | null;
  lines: (Line & { tone?: "ok" | "bad" })[];
  /** Each is a reason to refuse to sign. Empty when the server and the bytes agree. */
  mismatches: string[];
};

const same = (a?: string | null, b?: string | null) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

function money(units: bigint) {
  return `$${Number(formatUnits(units, 6)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Names from the server are labelled as such wherever they stand in for an address. */
function unverified(names: Record<string, string>) {
  return Object.fromEntries(Object.entries(names).map(([k, v]) => [k, `${v} (name from the app, not checked)`]));
}

export async function checkApproval(op: Op, data: Hex, claims: ServerClaims, chain: ChainReader): Promise<Truth> {
  if (op !== Op.Pay) {
    const d = describe(op, data, unverified(claims.names));
    const mismatches = claims.amountMinor ? ["The app shows an amount, but this action doesn't pay anyone"] : [];
    return { title: d.title, amountMinor: null, payee: null, lines: d.lines, mismatches };
  }

  const [to, amount, paymentId] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes32" }], data);
  const address = getAddress(to);

  // A contact counts as saved only if the vault's record for its id pays this exact address.
  let saved: Payee["saved"] = null;
  for (const c of claims.contacts) {
    try {
      const rec = await chain.contact(contactIdOf(c.payeeId));
      if (same(rec.payee, address)) {
        saved = { name: c.name, activeAt: Number(rec.activeAt) * 1000 };
        break;
      }
    } catch {
      // An unreadable record proves nothing; the payee stays unverified.
    }
  }

  const mismatches: string[] = [];
  const minor = fromTokenUnits(amount);
  if (claims.amountMinor !== undefined && claims.amountMinor !== minor) {
    mismatches.push(`The app says $${(claims.amountMinor / 100).toFixed(2)}, but the signature would pay ${money(amount)}`);
  }
  if (claims.payee?.address && !same(claims.payee.address, address)) {
    mismatches.push(`The app says ${claims.payee.name}, but the signature would pay a different address`);
  }
  if (claims.payee && saved && claims.payee.name !== saved.name) {
    mismatches.push(`The app says ${claims.payee.name}, but this address is saved as ${saved.name}`);
  }
  if (claims.payee && !saved) {
    mismatches.push(`The app says ${claims.payee.name}, but this address is not a saved contact in your vault`);
  }

  return {
    title: `Pay ${money(amount)}`,
    amountMinor: minor,
    payee: { address, saved },
    lines: [
      saved
        ? { label: "To", value: `${saved.name}, a saved contact in your vault`, tone: "ok" }
        : { label: "To", value: "NOT a saved contact in your vault", tone: "bad" },
      { label: "Address", value: address, mono: true },
      { label: "Amount", value: `${money(amount)} test dollars` },
      { label: "Payment ID", value: `${paymentId.slice(0, 10)}…`, mono: true },
    ],
    mismatches,
  };
}
