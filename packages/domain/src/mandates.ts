/**
 * AP2 (Agent Payments Protocol) mandates for PolicyVault, and a verifier that checks every claim in
 * them against the chain.
 *
 * AP2's three mandates map onto what the vault already enforces:
 *  - IntentMandate: what the owner let an assistant do, signed with the owner's passkey and checked by
 *    the contract (the agent's grant: contacts, per-payment and daily limits, expiry).
 *  - CartMandate: the owner approved one exact payment with their passkey.
 *  - PaymentMandate: an assistant paid under an intent mandate; the vault's own events are the record.
 *
 * AP2 field names are kept as the SDK defines them (ap2/models/mandate.py). What AP2 leaves to a
 * payment network or a signed credential, PolicyVault proves on-chain; that part sits under
 * "x-policyvault", and `verify*` below re-derives it from Base Sepolia with no trust in our server.
 */
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import { policyVaultAbi } from "./abi";
import { CHAIN_ID, EXPLORER } from "./vault";

export const INTENT_MANDATE_DATA_KEY = "ap2.mandates.IntentMandate";
export const CART_MANDATE_DATA_KEY = "ap2.mandates.CartMandate";
export const PAYMENT_MANDATE_DATA_KEY = "ap2.mandates.PaymentMandate";
/** The payment method AP2 names in payment requests and responses. */
export const PAYMENT_METHOD = "https://agent-wallet-nu.vercel.app/ap2/policyvault";

type Amount = { currency: "USD"; value: string };
const usd = (units: bigint): Amount => ({ currency: "USD", value: (Number(units) / 1e6).toFixed(2) });
const iso = (seconds: bigint | number) => new Date(Number(seconds) * 1000).toISOString();

/** Canonical JSON (sorted keys), so a mandate's id is the same wherever it is computed. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(typeof value === "bigint" ? value.toString() : value);
}
export const mandateId = (body: unknown) => `0x${bytesToHex(sha256(new TextEncoder().encode(canonical(body))))}`;

export type Contact = { name: string; address: Address; contactId: Hex };

export type IntentMandate = {
  [INTENT_MANDATE_DATA_KEY]: {
    user_cart_confirmation_required: boolean;
    natural_language_description: string;
    merchants: string[];
    skus: null;
    requires_refundability: boolean;
    intent_expiry: string;
  };
  "x-policyvault": {
    chain_id: number;
    vault: Address;
    agent: Address;
    agent_name: string;
    per_payment_max: Amount;
    daily_max: Amount;
    wallet_daily_ceiling: Amount;
    protected_amount: Amount;
    hold_above: Amount;
    hold_seconds: number;
    contacts: { name: string; address: Address; contact_id: Hex }[];
    /** The owner's passkey signature, checked by the contract: where it was verified, and where the grant applied. */
    user_authorization: { method: "webauthn-p256-verified-by-contract"; signed_tx: Hex; applied_tx: Hex };
  };
  mandate_id: string;
};

/** What the owner let one assistant do, from the grant the vault recorded. */
export function intentMandate(i: {
  vault: Address;
  agent: Address;
  agentName: string;
  perPayment: bigint;
  dailyCap: bigint;
  expiresAt: bigint;
  ceiling: bigint;
  protectedAmount: bigint;
  holdAbove: bigint;
  holdFor: number;
  contacts: Contact[];
  signedTx: Hex;
  appliedTx: Hex;
}): IntentMandate {
  const names = i.contacts.map((c) => c.name);
  const body = {
    [INTENT_MANDATE_DATA_KEY]: {
      // Inside these limits the owner's standing grant is the confirmation; anything above needs their passkey.
      user_cart_confirmation_required: false,
      natural_language_description:
        `${i.agentName} may pay ${names.length ? names.join(", ") : "no one yet"}, at most ${usd(i.perPayment).value} USD a payment and ` +
        `${usd(i.dailyCap).value} USD in any 24 hours, until ${iso(i.expiresAt).slice(0, 10)}. Payments above ${usd(i.holdAbove).value} USD wait ` +
        `${Math.round(i.holdFor / 60)} minutes so I can cancel. All assistants together stay under ${usd(i.ceiling).value} USD a day and never touch the ` +
        `${usd(i.protectedAmount).value} USD I keep protected. Anything else needs my passkey.`,
      merchants: names,
      skus: null,
      requires_refundability: false,
      intent_expiry: iso(i.expiresAt),
    },
    "x-policyvault": {
      chain_id: CHAIN_ID,
      vault: i.vault,
      agent: i.agent,
      agent_name: i.agentName,
      per_payment_max: usd(i.perPayment),
      daily_max: usd(i.dailyCap),
      wallet_daily_ceiling: usd(i.ceiling),
      protected_amount: usd(i.protectedAmount),
      hold_above: usd(i.holdAbove),
      hold_seconds: i.holdFor,
      contacts: i.contacts.map((c) => ({ name: c.name, address: c.address, contact_id: c.contactId })),
      user_authorization: { method: "webauthn-p256-verified-by-contract" as const, signed_tx: i.signedTx, applied_tx: i.appliedTx },
    },
  };
  return { ...body, mandate_id: mandateId(body) };
}

export type PaymentMandate = {
  [PAYMENT_MANDATE_DATA_KEY]: {
    payment_mandate_contents: {
      payment_mandate_id: string;
      payment_details_id: Hex;
      payment_details_total: { label: string; amount: Amount };
      payment_response: { request_id: Hex; method_name: string; details: { chain_id: number; vault: Address; agent: Address; transaction: string } };
      merchant_agent: string;
      timestamp: string;
    };
    /** AP2 puts a signed credential here; under PolicyVault the authority is the intent mandate the vault enforced. */
    user_authorization: string;
  };
  "x-policyvault": { tx: Hex; release_tx?: Hex; held: boolean; payee: Address; intent_mandate_id: string };
};

/** An assistant's payment under its intent mandate, as the vault recorded it. */
export function paymentMandate(p: {
  vault: Address;
  agent: Address;
  paymentId: Hex;
  amount: bigint;
  payee: Contact;
  label: string;
  tx: Hex;
  releaseTx?: Hex;
  held: boolean;
  timestamp: bigint;
  intent: IntentMandate;
}): PaymentMandate {
  const contents = {
    payment_details_id: p.paymentId,
    payment_details_total: { label: p.label, amount: usd(p.amount) },
    payment_response: {
      request_id: p.paymentId,
      method_name: PAYMENT_METHOD,
      details: { chain_id: CHAIN_ID, vault: p.vault, agent: p.agent, transaction: `${EXPLORER}/tx/${p.releaseTx ?? p.tx}` },
    },
    merchant_agent: p.payee.name,
    timestamp: iso(p.timestamp),
  };
  return {
    [PAYMENT_MANDATE_DATA_KEY]: {
      payment_mandate_contents: { payment_mandate_id: mandateId(contents), ...contents },
      user_authorization: `intent-mandate:${p.intent.mandate_id}`,
    },
    "x-policyvault": { tx: p.tx, release_tx: p.releaseTx, held: p.held, payee: p.payee.address, intent_mandate_id: p.intent.mandate_id },
  };
}

export type CartMandate = {
  [CART_MANDATE_DATA_KEY]: {
    contents: {
      id: Hex;
      user_cart_confirmation_required: true;
      payment_request: {
        method_data: { supported_methods: string; data: { chain_id: number; vault: Address } }[];
        details: { id: Hex; display_items: { label: string; amount: Amount }[]; total: { label: string; amount: Amount } };
      };
      cart_expiry: string;
      merchant_name: string;
    };
    /** AP2 has the merchant sign the cart; here the payee is a saved contact and the owner's passkey signs the exact payment. */
    merchant_authorization: null;
  };
  "x-policyvault": { tx: Hex; payee: Address; user_authorization: "webauthn-p256-verified-by-contract" };
  mandate_id: string;
};

/** A payment the owner approved exactly, with their passkey. */
export function cartMandate(c: { vault: Address; paymentId: Hex; amount: bigint; payee: Contact; label: string; deadline: bigint; tx: Hex }): CartMandate {
  const total = { label: c.label, amount: usd(c.amount) };
  const body = {
    [CART_MANDATE_DATA_KEY]: {
      contents: {
        id: c.paymentId,
        user_cart_confirmation_required: true as const,
        payment_request: {
          method_data: [{ supported_methods: PAYMENT_METHOD, data: { chain_id: CHAIN_ID, vault: c.vault } }],
          details: { id: c.paymentId, display_items: [total], total: { label: "Total", amount: total.amount } },
        },
        cart_expiry: iso(c.deadline),
        merchant_name: c.payee.name,
      },
      merchant_authorization: null,
    },
    "x-policyvault": { tx: c.tx, payee: c.payee.address, user_authorization: "webauthn-p256-verified-by-contract" as const },
  };
  return { ...body, mandate_id: mandateId(body) };
}

// ------------------------------------------------------------------ verification

export type Check = { ok: boolean; what: string; detail?: string };
export type Verdict = { valid: boolean; inForce?: boolean; checks: Check[] };

async function vaultEvents(pub: PublicClient, tx: Hex, vault: Address) {
  const r = await pub.getTransactionReceipt({ hash: tx });
  const logs = r.logs.filter((l) => l.address.toLowerCase() === vault.toLowerCase());
  return { receipt: r, events: parseEventLogs({ abi: policyVaultAbi, logs }) };
}

/**
 * Where the owner's passkey was verified for the change applied in `applied`: the same transaction
 * (tightening applies at once), or, for a loosening that waited out the vault's delay, the earlier
 * transaction that queued exactly this change. Found from the chain, not taken from the mandate.
 */
async function signedBy(pub: PublicClient, vault: Address, applied: Awaited<ReturnType<typeof vaultEvents>>): Promise<Hex | null> {
  if (applied.events.some((e) => e.eventName === "OwnerAction")) return applied.receipt.transactionHash;
  const done = applied.events.find((e) => e.eventName === "ChangeApplied");
  if (!done) return null;
  const changeId = (done.args as { changeId: Hex }).changeId;
  const end = applied.receipt.blockNumber;
  for (let to = end; to > end - 1800n && to > 0n; to -= 199n) {
    const logs = await pub.getLogs({ address: vault, fromBlock: to - 198n, toBlock: to });
    const q = parseEventLogs({ abi: policyVaultAbi, logs }).find((e) => e.eventName === "ChangeQueued" && (e.args as { changeId: Hex }).changeId === changeId);
    if (q) {
      const tx = await vaultEvents(pub, q.transactionHash, vault);
      return tx.events.some((e) => e.eventName === "OwnerAction") ? q.transactionHash : null;
    }
  }
  return null;
}

const same = (a?: string, b?: string) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
const units = (a: Amount) => BigInt(Math.round(Number(a.value) * 1e6));

/**
 * Re-derives an intent mandate from the chain: the contract verified the owner's passkey for this
 * grant, the grant's limits and expiry are the ones stated, each contact is saved in the vault, and
 * (separately) whether the grant is still in force today.
 */
export async function verifyIntent(m: IntentMandate, pub: PublicClient): Promise<Verdict> {
  const x = m["x-policyvault"];
  const checks: Check[] = [];
  const { [INTENT_MANDATE_DATA_KEY]: ap2, mandate_id, ...rest } = m;
  checks.push({ ok: mandateId({ [INTENT_MANDATE_DATA_KEY]: ap2, ...rest }) === mandate_id, what: "mandate_id is the hash of its contents" });
  checks.push({ ok: x.chain_id === CHAIN_ID && (await pub.getChainId()) === CHAIN_ID, what: "Base Sepolia" });

  const applied = await vaultEvents(pub, x.user_authorization.applied_tx, x.vault);
  const signer = await signedBy(pub, x.vault, applied);
  checks.push({
    ok: applied.receipt.status === "success" && Boolean(signer),
    what: "the owner's passkey signature for this grant was verified by the vault",
    detail: signer ? (signer === x.user_authorization.applied_tx ? `OwnerAction in ${signer}` : `OwnerAction in ${signer}, applied after the change delay in ${x.user_authorization.applied_tx}`) : "no passkey-verified action found",
  });
  if (signer && x.user_authorization.signed_tx !== signer) checks.push({ ok: false, what: "signed_tx names the transaction the passkey signed", detail: `chain says ${signer}` });
  const grant = applied.events.find((e) => e.eventName === "AgentSet" && same((e.args as { agent: string }).agent, x.agent));
  const g = grant?.args as { perPayment: bigint; dailyCap: bigint; expiresAt: bigint } | undefined;
  checks.push({ ok: Boolean(g), what: "the vault recorded this agent's grant", detail: g ? `AgentSet in ${x.user_authorization.applied_tx}` : "no AgentSet for this agent" });
  if (g) {
    checks.push({ ok: g.perPayment === units(x.per_payment_max), what: `per-payment limit ${x.per_payment_max.value} USD` });
    checks.push({ ok: g.dailyCap === units(x.daily_max), what: `24-hour limit ${x.daily_max.value} USD` });
    checks.push({ ok: iso(g.expiresAt) === ap2.intent_expiry, what: `expires ${ap2.intent_expiry}` });
  }
  checks.push({ ok: ap2.merchants.length === x.contacts.length && x.contacts.every((c, i) => c.name === ap2.merchants[i]), what: "AP2 merchants are the listed contacts" });
  for (const c of x.contacts) {
    const [payee] = (await pub.readContract({ address: x.vault, abi: policyVaultAbi, functionName: "contacts", args: [c.contact_id] })) as readonly [Address, ...unknown[]];
    checks.push({ ok: same(payee, c.address), what: `${c.name} is a saved contact at ${c.address.slice(0, 10)}…` });
  }
  const valid = checks.every((c) => c.ok);
  // In force today: the vault's current record for the agent still matches, and nothing revoked or froze it.
  const now = (await pub.readContract({ address: x.vault, abi: policyVaultAbi, functionName: "agents", args: [x.agent] })) as readonly [bigint, bigint, bigint, boolean, boolean, ...unknown[]];
  const [perPayment, dailyCap, expiresAt, active, frozen] = now;
  const block = await pub.getBlock();
  const inForce = active && !frozen && perPayment === units(x.per_payment_max) && dailyCap === units(x.daily_max) && expiresAt > block.timestamp;
  checks.push({ ok: inForce, what: inForce ? "still in force today" : `no longer in force (${!active ? "removed" : frozen ? "frozen" : expiresAt <= block.timestamp ? "expired" : "replaced by a newer grant"})` });
  return { valid, inForce, checks };
}

/** Re-derives a payment mandate: the vault paid (or held, then released) this amount to this payee from this agent, inside the intent. */
export async function verifyPayment(m: PaymentMandate, intent: IntentMandate, pub: PublicClient): Promise<Verdict> {
  const c = m[PAYMENT_MANDATE_DATA_KEY].payment_mandate_contents;
  const x = m["x-policyvault"];
  const vault = c.payment_response.details.vault;
  const checks: Check[] = [];
  const { payment_mandate_id, ...rest } = c;
  checks.push({ ok: mandateId(rest) === payment_mandate_id, what: "payment_mandate_id is the hash of its contents" });
  checks.push({ ok: x.intent_mandate_id === intent.mandate_id && m[PAYMENT_MANDATE_DATA_KEY].user_authorization === `intent-mandate:${intent.mandate_id}`, what: "made under the given intent mandate" });
  const { receipt, events } = await vaultEvents(pub, x.tx, vault);
  const paid = events.find((e) => (e.eventName === "PaymentExecuted" || e.eventName === "PaymentHeld") && (e.args as { paymentId: Hex }).paymentId === c.payment_details_id);
  const a = paid?.args as { agent: Address; payee: Address; amount: bigint } | undefined;
  checks.push({ ok: receipt.status === "success" && Boolean(a), what: x.held ? "the vault accepted and held this payment" : "the vault paid this payment" });
  if (a) {
    checks.push({ ok: same(a.agent, c.payment_response.details.agent) && same(a.agent, intent["x-policyvault"].agent), what: "paid with the mandate's agent key" });
    checks.push({ ok: a.amount === units(c.payment_details_total.amount), what: `amount ${c.payment_details_total.amount.value} USD` });
    checks.push({ ok: same(a.payee, x.payee) && intent["x-policyvault"].contacts.some((k) => same(k.address, a.payee)), what: `${c.merchant_agent} is one of the intent's contacts` });
    checks.push({ ok: a.amount <= units(intent["x-policyvault"].per_payment_max), what: "within the intent's per-payment limit" });
  }
  const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
  checks.push({ ok: iso(block.timestamp) <= intent[INTENT_MANDATE_DATA_KEY].intent_expiry, what: "made before the intent expired" });
  if (x.held) {
    const released = x.release_tx ? (await vaultEvents(pub, x.release_tx, vault)).events.find((e) => e.eventName === "PaymentReleased" && (e.args as { paymentId: Hex }).paymentId === c.payment_details_id) : undefined;
    checks.push({ ok: Boolean(released), what: "released after the hold (the owner didn't cancel)" });
  }
  return { valid: checks.every((k) => k.ok), checks };
}

/** Re-derives a cart mandate: the owner's passkey approved exactly this payment and the vault paid it. */
export async function verifyCart(m: CartMandate, pub: PublicClient): Promise<Verdict> {
  const c = m[CART_MANDATE_DATA_KEY].contents;
  const x = m["x-policyvault"];
  const vault = c.payment_request.method_data[0]!.data.vault;
  const checks: Check[] = [];
  const { [CART_MANDATE_DATA_KEY]: cart, mandate_id, ...rest } = m;
  checks.push({ ok: mandateId({ [CART_MANDATE_DATA_KEY]: cart, ...rest }) === mandate_id, what: "mandate_id is the hash of its contents" });
  const tx = await vaultEvents(pub, x.tx, vault);
  const signer = await signedBy(pub, vault, tx);
  const paid = tx.events.find((e) => e.eventName === "OwnerPaid" && (e.args as { paymentId: Hex }).paymentId === c.id);
  const a = paid?.args as { to: Address; amount: bigint } | undefined;
  checks.push({ ok: tx.receipt.status === "success" && Boolean(signer), what: "the owner's passkey signature for this payment was verified by the vault", detail: signer ?? undefined });
  checks.push({ ok: Boolean(a) && a!.amount === units(c.payment_request.details.total.amount) && same(a!.to, x.payee), what: `paid exactly ${c.payment_request.details.total.amount.value} USD to ${c.merchant_name}` });
  return { valid: checks.every((k) => k.ok), checks };
}
