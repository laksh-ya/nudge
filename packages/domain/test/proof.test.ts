import { describe, expect, it } from "vitest";
import { describeEvent, exposure, type ProofEvent } from "../src/proof";

const ev = (eventName: string, args: Record<string, unknown>): ProofEvent => ({ eventName, args, transactionHash: "0xab", blockNumber: 1n, logIndex: 0 });
const names = { agents: { "0x00000000000000000000000000000000000000c1": "Claude" }, contacts: { "0xcc": "Blue Tokai" }, addresses: {} };

describe("proof lines", () => {
  it("decodes a refusal code from the chain", () => {
    const l = describeEvent(ev("PaymentRefused", { agent: "0x00000000000000000000000000000000000000C1", contactId: "0xCC", amount: 50_000_000n, code: 2004 }), names);
    expect(l.title).toBe("Refused Claude: $50.00 to Blue Tokai");
    expect(l.detail).toContain("Code 2004");
    expect(l.tone).toBe("bad");
  });
  it("labels addresses it doesn't know without inventing a name", () => {
    const l = describeEvent(ev("OwnerPaid", { to: "0x1234567890123456789012345678901234567890", amount: 3_000_000n }), names);
    expect(l.title).toBe("You paid 0x123456… $3.00");
  });
});

describe("exposure", () => {
  const s = { balance: 250_000_000n, held: 8_000_000n, protectedAmount: 50_000_000n, dailyCeiling: 40_000_000n, spent24h: 12_000_000n, frozen: false };
  it("is bounded by the ceiling, the protected amount and what is already spent", () => {
    const e = exposure(s);
    expect(e.now).toBe(28_000_000n); // 40 ceiling - 12 spent
    expect(e.bound24h).toBe(40_000_000n);
    expect(e.committed).toBe(8_000_000n);
  });
  it("never counts money below the protected amount", () => {
    const e = exposure({ ...s, balance: 60_000_000n });
    expect(e.now).toBe(2_000_000n); // 60 - 8 held - 50 protected
    expect(e.bound24h).toBe(10_000_000n);
  });
  it("is zero while frozen", () => {
    expect(exposure({ ...s, frozen: true }).bound24h).toBe(0n);
  });
  it("caps a new grant's worst case by its own daily limit", () => {
    expect(exposure(s, { dailyCap: 15_000_000n }).bound24h).toBe(15_000_000n);
  });
});
