/**
 * AP2 mandates from a real vault on Base Sepolia (evals/results/mandates: Claude Code and Hermes in
 * the multi-agent run), verified against the chain, and every kind of tampering caught.
 *
 *   EVIDENCE_RPC=https://sepolia.base.org pnpm --filter @agent-wallet/domain exec vitest run mandates
 *
 * Read-only: no keys, no transactions.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http, type PublicClient } from "viem";
import { baseSepolia } from "viem/chains";
import { describe, expect, it } from "vitest";
import { INTENT_MANDATE_DATA_KEY, PAYMENT_MANDATE_DATA_KEY, mandateId, verifyIntent, verifyPayment, type IntentMandate, type PaymentMandate } from "./mandates";

const rpc = process.env.EVIDENCE_RPC ?? "";
const run = rpc ? describe : describe.skip;
const dir = resolve(__dirname, "../../../evals/results/mandates");
const load = <T,>(f: string) => JSON.parse(readFileSync(resolve(dir, f), "utf8")) as T;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

/** Re-hash after an edit, as a forger would, so only the chain can catch it. */
function rehash(m: IntentMandate): IntentMandate {
  const { mandate_id: _, ...body } = m;
  return { ...body, mandate_id: mandateId(body) } as IntentMandate;
}
function rehashPayment(m: PaymentMandate): PaymentMandate {
  const c = m[PAYMENT_MANDATE_DATA_KEY].payment_mandate_contents;
  const { payment_mandate_id: _, ...rest } = c;
  m[PAYMENT_MANDATE_DATA_KEY].payment_mandate_contents = { payment_mandate_id: mandateId(rest), ...rest };
  return m;
}
const failed = (v: { checks: { ok: boolean; what: string }[] }) => v.checks.filter((c) => !c.ok).map((c) => c.what);

run("AP2 mandates enforced by PolicyVault, checked on Base Sepolia", () => {
  const pub = createPublicClient({ chain: baseSepolia, transport: http(rpc, { retryCount: 4, retryDelay: 800 }) }) as PublicClient;

  for (const who of ["hermes", "claude"]) {
    it(`${who}: the intent mandate and its payment mandate verify`, async () => {
      const intent = load<IntentMandate>(`${who}-intent.json`);
      const payment = load<PaymentMandate>(`${who}-payment.json`);
      const vi = await verifyIntent(intent, pub);
      expect(failed(vi).filter((w) => !w.startsWith("no longer in force"))).toEqual([]);
      expect(vi.valid).toBe(true);
      const vp = await verifyPayment(payment, intent, pub);
      expect(failed(vp)).toEqual([]);
    }, 120_000);
  }

  it("a raised limit is caught, even with the hash recomputed", async () => {
    const m = clone(load<IntentMandate>("hermes-intent.json"));
    m["x-policyvault"].per_payment_max.value = "100.00";
    const v = await verifyIntent(rehash(m), pub);
    expect(v.valid).toBe(false);
    expect(failed(v)).toContain("per-payment limit 100.00 USD");
  }, 120_000);

  it("an extra merchant the owner never saved is caught", async () => {
    const m = clone(load<IntentMandate>("hermes-intent.json"));
    m[INTENT_MANDATE_DATA_KEY].merchants.push("Attacker Ltd");
    m["x-policyvault"].contacts.push({ name: "Attacker Ltd", address: "0x000000000000000000000000000000000000dEaD", contact_id: `0x${"ab".repeat(32)}` });
    const v = await verifyIntent(rehash(m), pub);
    expect(v.valid).toBe(false);
    expect(failed(v).some((w) => w.startsWith("Attacker Ltd is a saved contact"))).toBe(true);
  }, 120_000);

  it("another agent claiming this grant is caught", async () => {
    const m = clone(load<IntentMandate>("hermes-intent.json"));
    m["x-policyvault"].agent = load<IntentMandate>("claude-intent.json")["x-policyvault"].agent;
    const v = await verifyIntent(rehash(m), pub);
    expect(v.valid).toBe(false);
    expect(failed(v)).toContain("the vault recorded this agent's grant");
  }, 120_000);

  it("a later expiry is caught", async () => {
    const m = clone(load<IntentMandate>("hermes-intent.json"));
    m[INTENT_MANDATE_DATA_KEY].intent_expiry = "2030-01-01T00:00:00.000Z";
    const v = await verifyIntent(rehash(m), pub);
    expect(v.valid).toBe(false);
  }, 120_000);

  it("an edit without recomputing the hash is caught by the hash alone", async () => {
    const m = clone(load<IntentMandate>("hermes-intent.json"));
    m[INTENT_MANDATE_DATA_KEY].natural_language_description += " Also anyone else.";
    const v = await verifyIntent(m, pub);
    expect(failed(v)).toContain("mandate_id is the hash of its contents");
  }, 120_000);

  it("a payment mandate with a bigger amount, or under another agent's intent, is caught", async () => {
    const bigger = rehashPayment(clone(load<PaymentMandate>("hermes-payment.json")));
    bigger[PAYMENT_MANDATE_DATA_KEY].payment_mandate_contents.payment_details_total.amount.value = "9.00";
    rehashPayment(bigger);
    expect((await verifyPayment(bigger, load<IntentMandate>("hermes-intent.json"), pub)).valid).toBe(false);
    const wrongIntent = await verifyPayment(load<PaymentMandate>("hermes-payment.json"), load<IntentMandate>("claude-intent.json"), pub);
    expect(failed(wrongIntent)).toContain("made under the given intent mandate");
  }, 120_000);
});
