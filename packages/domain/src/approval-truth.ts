import { decodeAbiParameters, formatUnits, getAddress, type Address, type Hex } from "viem";
import { Op, contactIdOf, describe, fromTokenUnits, type Line } from "./vault";
import { exposure, type VaultState } from "./proof";

/**
 * What the approval page may show, worked out only from the bytes the passkey will sign and from
 * the vault's own on-chain records. Anything the server says (amount, payee, names) is checked
 * against those, and a disagreement disables approval. Pure: the page passes in a chain reader.
 */

/** Reads the vault on Base Sepolia from a public RPC, never through our server. */
export type ChainReader = {
  contact(contactId: Hex): Promise<{ payee: Address; activeAt: bigint }>;
  /** The vault's own numbers, for the worst case a new agent grant adds. */
  state?(): Promise<VaultState>;
};

/** The daily limits an action grants to agent keys, read from the bytes. */
function grantedCaps(op: Op, data: Hex): bigint[] {
  if (op === Op.SetAgent) {
    const [, , dailyCap] = decodeAbiParameters([{ type: "address" }, { type: "uint128" }, { type: "uint128" }, { type: "uint64" }], data);
    return [dailyCap];
  }
  if (op === Op.Batch) {
    const [ops, datas] = decodeAbiParameters([{ type: "uint8[]" }, { type: "bytes[]" }], data);
    return ops.flatMap((o, i) => (o === Op.SetAgent ? grantedCaps(Op.SetAgent, datas[i]!) : []));
  }
  return [];
}

/** What the server claims about the request. None of it is trusted. */
export type ServerClaims = {
  amountMinor?: number;
  payee?: { name: string; address?: string | null } | null;
  /**
   * Contacts the server has for addresses in the bytes: the id their on-chain record is keyed by.
   * `saved: false` is the server saying "this is a new payee, not in the vault"; anything else is a
   * claim that the vault has it, which the page checks.
   */
  contacts: { payeeId: string; name: string; address?: string | null; saved?: boolean }[];
  /** Names for other addresses in the bytes (agent keys, new contacts). Shown as unverified. */
  names: Record<string, string>;
};

export type Payee = {
  address: Address;
  /** A saved contact in this vault, confirmed by reading the vault. */
  saved: { name: string; activeAt: number } | null;
  /**
   * Not in the vault, and the server doesn't claim it is: a first payment to someone new. Still shown
   * as "not a saved contact" in red with the full address (it is how a swapped payee shows up); the
   * page asks the owner to confirm they checked the address before the passkey can sign (#90, #91).
   * The vault then queues the payment for its change delay, cancellable.
   */
  fresh: boolean;
  /** The name the app uses for a new payee. Not checked: it is shown as such. */
  label?: string;
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
    const lines: Truth["lines"] = [...d.lines];
    const caps = grantedCaps(op, data);
    if (caps.length && chain.state) {
      // Exposure preview: what this grant could cost if the agent key were stolen, from the vault's own numbers.
      try {
        const e = exposure(await chain.state(), { dailyCap: caps.reduce((a, b) => a + b, 0n) });
        lines.push({
          label: caps.length === 1 ? "If this key leaks" : "If these keys leak",
          value: `At most ${money(e.bound24h)} in any 24 hours (${money(e.now)} today), never below your protected amount`,
          tone: "bad",
        });
      } catch {
        // The worst case is shown only when it could be read from the chain.
      }
    }
    return { title: d.title, amountMinor: null, payee: null, lines, mismatches };
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
  // The server claims the vault has this address (as a contact for it); the vault says otherwise.
  // A new payee the server labels as new is not a disagreement: the page says so plainly (#90, #91).
  const claimedSaved = claims.contacts.some((c) => same(c.address, address) && c.saved !== false);
  if (claims.payee && !saved && claimedSaved) {
    mismatches.push(`The app says ${claims.payee.name} is a saved contact, but your vault has no saved contact at this address`);
  }
  const fresh = !saved && !claimedSaved;
  const label = fresh ? (claims.payee?.name ?? claims.names[address.toLowerCase()]) : undefined;
  const waiting = saved && saved.activeAt > Date.now();

  return {
    title: `Pay ${money(amount)}`,
    amountMinor: minor,
    payee: { address, saved, fresh, ...(label ? { label } : {}) },
    lines: [
      saved
        ? {
            label: "To",
            value: waiting
              ? `${saved.name}, saved in your vault; agents may pay it on their own from ${new Date(saved.activeAt).toLocaleString()}`
              : `${saved.name}, a saved contact in your vault`,
            tone: "ok",
          }
        : fresh
          ? { label: "To", value: `NOT a saved contact in your vault: a first payment to this address${label ? ` (the app calls it ${label}, not checked)` : ""}. Paying once doesn't save it`, tone: "bad" }
          : { label: "To", value: "NOT a saved contact in your vault", tone: "bad" },
      { label: "Address", value: address, mono: true },
      { label: "Amount", value: `${money(amount)} test dollars` },
      { label: "Payment ID", value: `${paymentId.slice(0, 10)}…`, mono: true },
    ],
    mismatches,
  };
}
