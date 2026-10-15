import { describe, expect, it } from "vitest";
import { Op, actionDigest, contactIdOf, describe as describeOp, encode, fromTokenUnits, toTokenUnits } from "./vault";

describe("vault encoding", () => {
  it("matches the contract's digest byte for byte", () => {
    // Expected value read from PolicyVault.digest() on a local chain (chain id 84532).
    const vault = "0xC5ae8e7956998f5D8dEaC5063261828dcD97E3D5";
    const data = encode.pay("0x1111111111111111111111111111111111111111", 12_500_000n, `0x${"7".padStart(64, "0")}`);
    const digest = actionDigest({ op: Op.Pay, data, nonce: 42n, deadline: 1_800_000_000n }, vault);
    expect(digest).toBe("0x699565b62cb454a5a472a60597b52cc5d0485571bd4cc2ccb962b64be3937f98");
  });

  it("converts cents to 6-decimal token units", () => {
    expect(toTokenUnits(1_250)).toBe(12_500_000n);
    expect(fromTokenUnits(12_500_000n)).toBe(1_250);
  });

  it("renders what is being signed from the bytes alone", () => {
    const data = encode.pay("0x1111111111111111111111111111111111111111", 12_500_000n, contactIdOf("x"));
    const d = describeOp(Op.Pay, data, { "0x1111111111111111111111111111111111111111": "Blue Tokai" });
    expect(d.title).toBe("Pay $12.50");
    expect(d.lines.find((l) => l.label === "To")?.value).toBe("Blue Tokai");
  });
});
