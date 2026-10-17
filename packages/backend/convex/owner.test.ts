/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Op, toTokenUnits } from "@agent-wallet/domain";
import { decodeAbiParameters } from "viem";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./lib/relayer", () => {
  const pool = { enqueueAction: vi.fn(async () => "queued") };
  return { relayer: pool, agentPool: pool, lanePool: () => pool, laneOf: () => 0, laneCount: () => 1, MAX_LANES: 4 };
});
const modules = import.meta.glob(["./**/*.ts", "./**/*.js", "!./**/*.test.ts"]);

const NOW = Date.UTC(2026, 9, 17, 6);
const VAULT = "0x85EFA7346e408DB2c28D01bA0De82E77F01900a8";
const SHOP = "0xCb4C82Dc556883c90eBd9a7440b096728a7A5fc6";
const MINE = "0x000000000000000000000000000000000000dEaD";
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

/** A live v3 vault: $100 in it, $20 held for an agent, $50 protected. */
async function fixture(opts: { live?: boolean } = {}) {
  const live = opts.live ?? true;
  const t = convexTest(schema, modules);
  const owner = t.withIdentity({ subject: "alice", issuer: "https://test.local", tokenIdentifier: "https://test.local|alice" });
  const stranger = t.withIdentity({ subject: "eve", issuer: "https://test.local", tokenIdentifier: "https://test.local|eve" });
  const alice = (await owner.mutation(api.users.ensure, {}))!;
  await stranger.mutation(api.users.ensure, {});
  const payee = await t.run(async (ctx) => {
    await ctx.db.insert("wallets", {
      userId: alice, address: live ? VAULT : "", chain: "base-sepolia", asset: "USDC", balanceMinor: 10_000,
      protectedMinor: 5000, dailyCeilingMinor: 10_000, perPaymentMinor: 2000, frozen: false,
      ...(live
        ? {
            status: "live" as const, version: 3,
            vault: { version: 3, protectedMinor: 5000, ceilingMinor: 10_000, contactDelay: 60, changeDelay: 120, holdAboveMinor: 500, holdFor: 300, frozen: false, balanceMinor: 10_000, heldMinor: 2000, spentMinor: 0, headroomMinor: 3000, ownerKeys: 1, syncedAt: NOW },
          }
        : {}),
    });
    return await ctx.db.insert("payees", { userId: alice, name: "Blue Tokai", handle: "shop", kind: "merchant", trusted: true, address: SHOP, onchain: true });
  });
  return { t, owner, stranger, payee };
}

const reason = (e: unknown) => (e instanceof ConvexError ? (e.data as string) : String(e));

describe("the owner paying from the Wallet screen (#11)", () => {
  it("prepares the exact payment for the passkey, and pays nothing yet", async () => {
    const f = await fixture();
    const token = await f.owner.mutation(api.owner.pay, { payeeId: f.payee, amountMinor: 1250, note: " beans " });
    expect(token).toMatch(/.{16,}/);
    const task = await f.t.run(async (ctx) => (await ctx.db.query("tasks").collect())[0]!);
    expect(task).toMatchObject({ state: "awaiting_approval", payeeId: f.payee, amountMinor: 1250, currency: "USDC", purpose: "beans", channel: "app", approvalToken: token });
  });

  it("refuses an amount that would dip into the protected amount or the held money", async () => {
    const f = await fixture();
    // $100 balance − $20 held − $50 protected = $30 payable.
    await f.owner.mutation(api.owner.pay, { payeeId: f.payee, amountMinor: 3000 });
    const err = await f.owner.mutation(api.owner.pay, { payeeId: f.payee, amountMinor: 3001 }).catch((e: unknown) => e);
    expect(reason(err)).toMatch(/Only \$30\.00 can be paid/);
  });

  it("refuses zero, fractions of a cent and someone else's contact", async () => {
    const f = await fixture();
    for (const amountMinor of [0, -5, 12.5]) {
      expect(reason(await f.owner.mutation(api.owner.pay, { payeeId: f.payee, amountMinor }).catch((e: unknown) => e))).toMatch(/above \$0/);
    }
    await expect(f.stranger.mutation(api.owner.pay, { payeeId: f.payee, amountMinor: 100 })).rejects.toThrow(/Not found/);
  });

  it("needs a wallet that's on-chain", async () => {
    const f = await fixture({ live: false });
    await expect(f.owner.mutation(api.owner.pay, { payeeId: f.payee, amountMinor: 100 })).rejects.toThrow(/isn't on-chain yet/);
  });
});

describe("the owner withdrawing from the Wallet screen (#11)", () => {
  it("encodes a Withdraw of exactly that amount to exactly that address", async () => {
    const f = await fixture();
    const token = await f.owner.mutation(api.owner.withdraw, { to: MINE.toLowerCase(), amountMinor: 8000 });
    const task = await f.t.run(async (ctx) => (await ctx.db.query("tasks").collect())[0]!);
    expect(task.approvalToken).toBe(token);
    expect(task.state).toBe("awaiting_approval");
    expect(task.action!.op).toBe(Op.Withdraw);
    const [to, amount] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], task.action!.data as `0x${string}`);
    expect(to).toBe(MINE);
    expect(amount).toBe(toTokenUnits(8000));
    expect(task.reason).toMatch(/2-minute change delay/);
  });

  it("may go below the protected amount, but never touches held money", async () => {
    const f = await fixture();
    // $100 balance − $20 held = $80 withdrawable.
    const err = await f.owner.mutation(api.owner.withdraw, { to: MINE, amountMinor: 8001 }).catch((e: unknown) => e);
    expect(reason(err)).toMatch(/Only \$80\.00 can be withdrawn/);
  });

  it("refuses a malformed, mis-checksummed, empty or self address", async () => {
    const f = await fixture();
    const bad = async (to: string) => reason(await f.owner.mutation(api.owner.withdraw, { to, amountMinor: 100 }).catch((e: unknown) => e));
    expect(await bad("0x1234")).toMatch(/isn't a wallet address/);
    expect(await bad("0xCB4C82Dc556883c90eBd9a7440b096728a7A5fc6")).toMatch(/checksum/);
    expect(await bad("0x0000000000000000000000000000000000000000")).toMatch(/can't receive/);
    expect(await bad(VAULT)).toMatch(/own address/);
  });

  it("is refused for a read-only judge visitor", async () => {
    const f = await fixture();
    const judge = f.t.withIdentity({ subject: "judge", issuer: "https://demo.agent-wallet.app", tokenIdentifier: "https://demo.agent-wallet.app|judge", judgeAdmin: false });
    await judge.mutation(api.users.ensure, {});
    await expect(judge.mutation(api.owner.withdraw, { to: MINE, amountMinor: 100 })).rejects.toThrow(/read-only/);
  });
});
