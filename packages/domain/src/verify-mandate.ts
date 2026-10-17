/**
 * Verify AP2 mandates from PolicyVault against Base Sepolia, with no trust in our server.
 *
 *   cd packages/domain && npx tsx src/verify-mandate.ts <intent.json> [payment-or-cart.json ...]
 *
 * An intent mandate is checked on its own; each payment mandate is checked against the intent
 * mandate given first. Exit code 1 if anything fails. RPC: EVIDENCE_RPC, else the public node.
 */
import { readFileSync } from "node:fs";
import { createPublicClient, http, type PublicClient } from "viem";
import { baseSepolia } from "viem/chains";
import {
  CART_MANDATE_DATA_KEY,
  INTENT_MANDATE_DATA_KEY,
  PAYMENT_MANDATE_DATA_KEY,
  verifyCart,
  verifyIntent,
  verifyPayment,
  type CartMandate,
  type IntentMandate,
  type PaymentMandate,
  type Verdict,
} from "./mandates";

const pub = createPublicClient({ chain: baseSepolia, transport: http(process.env.EVIDENCE_RPC ?? "https://sepolia.base.org", { retryCount: 4, retryDelay: 800 }) }) as PublicClient;

function print(label: string, v: Verdict) {
  console.log(`\n${v.valid ? "VALID" : "INVALID"}  ${label}`);
  for (const c of v.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.what}${c.detail ? `  (${c.detail})` : ""}`);
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: npx tsx src/verify-mandate.ts <intent.json> [payment-or-cart.json ...]");
  process.exit(2);
}
let intent: IntentMandate | null = null;
let failed = false;
for (const f of files) {
  const m = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
  let v: Verdict;
  if (INTENT_MANDATE_DATA_KEY in m) {
    intent = m as unknown as IntentMandate;
    v = await verifyIntent(intent, pub);
  } else if (PAYMENT_MANDATE_DATA_KEY in m) {
    if (!intent) throw new Error(`${f}: give the intent mandate before its payment mandates`);
    v = await verifyPayment(m as unknown as PaymentMandate, intent, pub);
  } else if (CART_MANDATE_DATA_KEY in m) {
    v = await verifyCart(m as unknown as CartMandate, pub);
  } else throw new Error(`${f}: not an AP2 mandate`);
  print(f, v);
  failed ||= !v.valid;
}
process.exit(failed ? 1 : 0);
