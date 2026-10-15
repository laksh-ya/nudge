import { describe, expect, it } from "vitest";
import { Op, actionDigest, changeIdOf, contactIdOf, describe as describeOp, encode, fromTokenUnits, keyIdOf, toTokenUnits } from "./vault";

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

  it("encodes a contact for the vault's own version and shows its cap", () => {
    const shop = "0x1111111111111111111111111111111111111111";
    const v2 = encode.addContact(contactIdOf("c"), shop, false, { version: 2, dailyCap: 9_000_000n });
    const v3 = encode.addContact(contactIdOf("c"), shop, false, { version: 3, dailyCap: 9_000_000n });
    expect((v2.length - 2) / 2).toBe(96);
    expect((v3.length - 2) / 2).toBe(128);
    expect(describeOp(Op.AddContact, v2, {}).lines.map((l) => l.label)).not.toContain("All agents, per 24 hours");
    expect(describeOp(Op.AddContact, v3, {}).lines).toContainEqual({ label: "All agents, per 24 hours", value: "$9.00" });
    const uncapped = encode.addContact(contactIdOf("c"), shop, true);
    expect(describeOp(Op.AddContact, uncapped, {}).lines).toContainEqual({ label: "All agents, per 24 hours", value: "No cap for this contact" });
  });

  it("derives passkey ids the way the contract does", () => {
    // cast keccak $(cast abi-encode "f(bytes32,bytes32)" 0x11..11 0x22..22)
    expect(keyIdOf(`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`)).toBe("0x3e92e0db88d6afea9edc4eedf62fffa4d92bcdfc310dccbe943747fe8302e871");
  });

  it("derives queued-change ids the way the contract does", () => {
    const data = encode.withdraw("0x1111111111111111111111111111111111111111", 10_000_000n);
    expect(changeIdOf(Op.Withdraw, data, 7n)).toBe("0x816ee5fc5c086979e3ec9d9ae157d3eb871fe849e2bd4a2939a9f3f7a87353ce");
  });

  it("spells out every rule a policy change sets", () => {
    const data = encode.setPolicy({ protectedAmount: 50_000_000n, dailyCeiling: 40_000_000n, newContactDelay: 86_400n, changeDelay: 600n, holdAbove: 5_000_000n, holdFor: 300n });
    const d = describeOp(Op.SetPolicy, data);
    expect(d.lines.map((l) => l.value)).toEqual(["$50.00", "$40.00", "1 days", "10 min", "Above $5.00, for 5 min"]);
  });
});
