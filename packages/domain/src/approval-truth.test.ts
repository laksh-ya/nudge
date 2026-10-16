import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { checkApproval, type ChainReader } from "./approval-truth";
import { Op, contactIdOf, encode, toTokenUnits } from "./vault";

const SHOP = "0xCb4C82Dc556883c90eBd9a7440b096728a7A5fc6" as Address;
const ATTACKER = "0x9b1c4f0e2a7d33c8e5f61a20b4d7e9c3f2a18b55" as Address;
const PAYMENT = `0x${"ab".repeat(32)}` as Hex;

/** A vault whose only saved contact is the shop, under payee id "payee-shop". */
const chain: ChainReader = {
  async contact(id) {
    if (id === contactIdOf("payee-shop")) return { payee: SHOP, activeAt: 1_790_000_000n };
    return { payee: "0x0000000000000000000000000000000000000000", activeAt: 0n };
  },
};

const honest = {
  amountMinor: 1200,
  payee: { name: "Blue Tokai", address: SHOP },
  contacts: [{ payeeId: "payee-shop", name: "Blue Tokai", address: SHOP }],
  names: { [SHOP.toLowerCase()]: "Blue Tokai" },
};

describe("approval page truth", () => {
  it("shows a saved contact, confirmed by the vault, when everything agrees", async () => {
    const t = await checkApproval(Op.Pay, encode.pay(SHOP, toTokenUnits(1200), PAYMENT), honest, chain);
    expect(t.mismatches).toEqual([]);
    expect(t.amountMinor).toBe(1200);
    expect(t.payee?.saved?.name).toBe("Blue Tokai");
    expect(t.lines[0]).toMatchObject({ value: "Blue Tokai, a saved contact in your vault", tone: "ok" });
  });

  it("warns, and blocks approval, when the server labels an attacker's address as a saved contact", async () => {
    // A compromised server: says "Blue Tokai, $12" and maps the attacker's address to that name.
    const tampered = { ...honest, names: { [ATTACKER.toLowerCase()]: "Blue Tokai" }, contacts: [{ payeeId: "payee-shop", name: "Blue Tokai", address: ATTACKER }] };
    const t = await checkApproval(Op.Pay, encode.pay(ATTACKER, toTokenUnits(20_000), PAYMENT), tampered, chain);
    expect(t.payee?.saved).toBeNull();
    expect(t.lines[0]).toMatchObject({ value: "NOT a saved contact in your vault", tone: "bad" });
    expect(t.title).toBe("Pay $200.00");
    expect(t.mismatches.join(" ")).toMatch(/says \$12\.00, but the signature would pay \$200\.00/);
    expect(t.mismatches.join(" ")).toMatch(/not a saved contact/);
  });

  it("flags a payee name that doesn't match the vault's own record", async () => {
    const t = await checkApproval(Op.Pay, encode.pay(SHOP, toTokenUnits(1200), PAYMENT), { ...honest, payee: { name: "Ramesh Iyer", address: SHOP } }, chain);
    expect(t.mismatches.join(" ")).toMatch(/saved as Blue Tokai/);
  });

  it("treats an unreadable chain record as unverified, never as saved", async () => {
    const down: ChainReader = { contact: async () => Promise.reject(new Error("rpc down")) };
    const t = await checkApproval(Op.Pay, encode.pay(SHOP, toTokenUnits(1200), PAYMENT), honest, down);
    expect(t.payee?.saved).toBeNull();
    expect(t.mismatches.length).toBeGreaterThan(0);
  });

  it("refuses an amount shown for an action that pays no one", async () => {
    const data = encode.unfreeze("0x0000000000000000000000000000000000000000");
    const t = await checkApproval(Op.Unfreeze, data, { ...honest, amountMinor: 1200 }, chain);
    expect(t.amountMinor).toBeNull();
    expect(t.mismatches).toHaveLength(1);
  });

  it("marks server-supplied names as unchecked on other actions", async () => {
    const data = encode.setAgent(ATTACKER, toTokenUnits(1000), toTokenUnits(1500), 1_800_000_000n);
    const t = await checkApproval(Op.SetAgent, data, { amountMinor: undefined, payee: null, contacts: [], names: { [ATTACKER.toLowerCase()]: "Claude" } }, chain);
    expect(t.lines.find((l) => l.label === "Agent")?.value).toBe("Claude (name from the app, not checked)");
  });
});

describe("exposure preview for agent grants", () => {
  it("shows the most a new agent key could lose in 24 hours, read from the vault", async () => {
    const { checkApproval } = await import("./approval-truth");
    const { Op, encode } = await import("./vault");
    const data = encode.setAgent("0x00000000000000000000000000000000000000c1", 10_000_000n, 15_000_000n, 2_000_000_000n);
    const chain = {
      contact: async () => ({ payee: "0x0000000000000000000000000000000000000000" as const, activeAt: 0n }),
      state: async () => ({ balance: 250_000_000n, held: 0n, protectedAmount: 50_000_000n, dailyCeiling: 40_000_000n, spent24h: 30_000_000n, frozen: false }),
    };
    const t = await checkApproval(Op.SetAgent, data, { contacts: [], names: {} }, chain);
    const line = t.lines.find((l) => l.label === "If this key leaks")!;
    expect(line.value).toBe("At most $15.00 in any 24 hours ($10.00 today), never below your protected amount");
  });
});
