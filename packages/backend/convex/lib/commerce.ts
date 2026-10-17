import type { Doc } from "../_generated/dataModel";

/**
 * x402 as Nudge speaks it. A merchant answers 402 Payment Required with what it accepts; the wallet
 * pays through the vault (the same limits and approvals as any payment) and retries with proof.
 *
 * Scheme "transfer": the payer sends tUSD on Base Sepolia to `payTo` and proves it with the
 * transaction hash in X-PAYMENT. Vault wallets can't sign the EIP-3009 authorisations that x402's
 * "exact" scheme expects (the money sits in a contract, not a key), so "exact" offers are reported
 * plainly instead of half-paid. A simulated wallet proves its payment with a Nudge-signed receipt,
 * which only Nudge's own demo store accepts.
 */

export const X402_VERSION = 1;
export const NETWORK = "base-sepolia";
export const SCHEME = "transfer";
/** tUSD has 6 decimals; the app counts cents. */
export const UNITS_PER_CENT = 10_000n;

export type Offer = {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource?: string;
  description?: string;
  mimeType?: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  asset: string;
  extra?: Record<string, unknown>;
};

export type PaymentRequired = { x402Version: number; error?: string; accepts: Offer[] };

export function isPaymentRequired(x: unknown): x is PaymentRequired {
  return Boolean(x && typeof x === "object" && Array.isArray((x as PaymentRequired).accepts));
}

/** The offer the vault can pay, or why none fits. */
export function pickOffer(body: PaymentRequired, token: string): { offer: Offer; cents: number } | { problem: string } {
  const offers = body.accepts.filter((o) => o && typeof o === "object");
  if (!offers.length) return { problem: "The merchant's 402 answer lists no payment options." };
  const ours = offers.find((o) => o.scheme === SCHEME && o.network === NETWORK && o.asset?.toLowerCase() === token.toLowerCase());
  if (!ours) {
    const seen = offers.map((o) => `${o.scheme} on ${o.network}`).join(", ");
    const exact = offers.some((o) => o.scheme === "exact");
    return {
      problem: `The merchant accepts ${seen}. Nudge pays x402 offers with scheme "transfer" on base-sepolia in the wallet's test dollars${exact ? '; the "exact" scheme needs a key-held USDC signature, which a vault wallet can\'t give' : ""}.`,
    };
  }
  let units: bigint;
  try {
    units = BigInt(ours.maxAmountRequired);
  } catch {
    return { problem: "The merchant's price isn't a whole number of token units." };
  }
  if (units <= 0n || units % UNITS_PER_CENT !== 0n) return { problem: "The merchant's price isn't a whole number of cents." };
  return { offer: ours, cents: Number(units / UNITS_PER_CENT) };
}

export function b64(json: unknown) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(json))));
}
export function unb64<T>(s: string): T | null {
  try {
    return JSON.parse(decodeURIComponent(escape(atob(s)))) as T;
  } catch {
    return null;
  }
}

export type PaymentProof = { x402Version: number; scheme: string; network: string; payload: { txHash?: string; receipt?: string } };

async function hmac(secret: string, text: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

function receiptSecret() {
  return process.env.X402_RECEIPT_SECRET ?? `nudge-simulated-receipts:${process.env.CONVEX_CLOUD_URL ?? "local"}`;
}

/** A receipt for a simulated payment (amount and when it was made): only Nudge's own store can check it. */
export async function simulatedReceipt(taskId: string, payTo: string, cents: number, at: number) {
  return `${taskId}.${cents}.${at}.${await hmac(receiptSecret(), `${taskId}|${payTo.toLowerCase()}|${cents}|${at}`)}`;
}

/** The paid amount and time a receipt vouches for, or null if it's forged. */
export async function checkReceipt(receipt: string, payTo: string): Promise<{ cents: number; at: number } | null> {
  const [taskId, paid, at, sig] = receipt.split(".");
  if (!taskId || !paid || !at || !sig) return null;
  if (sig !== (await hmac(receiptSecret(), `${taskId}|${payTo.toLowerCase()}|${paid}|${at}`))) return null;
  return { cents: Number(paid), at: Number(at) };
}

/** An item's price at a moment, from its recent history (older than the history: its base price). */
export function priceAt(item: { basePriceMinor: number; priceMinor: number; history?: { priceMinor: number; from: number }[] }, at: number) {
  const h = (item.history ?? []).filter((x) => x.from <= at).sort((a, b) => b.from - a.from)[0];
  return h ? h.priceMinor : item.history?.length ? item.basePriceMinor : item.priceMinor;
}

/** Luhn-valid test card number on the 4242 test range; never a real card. */
export function testCardNumber(seed: string) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const body = `424242${String(h).padStart(9, "0").slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let d = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return body + ((10 - (sum % 10)) % 10);
}

/** What an assistant may see of a purchase: the resource once paid; card details once loaded. */
export function purchaseView(p: NonNullable<Doc<"tasks">["purchase"]>, state: string) {
  const paid = state === "confirmed";
  return {
    kind: p.kind,
    url: p.url ?? null,
    item: p.item ?? null,
    merchant: p.merchant ?? null,
    ...(p.kind !== "card" ? { resource: paid ? (p.resource ?? (p.deliveryError ? null : "fetching…")) : null, deliveryError: p.deliveryError ?? null } : {}),
    ...(p.card
      ? paid
        ? { card: { number: p.card.number, exp: p.card.exp, cvc: p.card.cvc, simulated: true, note: "Test card number: works only in test checkouts. Single use, loaded with exactly this payment." } }
        : { card: { last4: p.card.last4, ready: false, note: "The card is loaded once the payment is confirmed." } }
      : {}),
  };
}

/** Merchant name from a URL, for the owner's approval screen. */
export function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "x402 merchant";
  }
}
