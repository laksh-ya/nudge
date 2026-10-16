/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Op, describe as describeOp } from "@agent-wallet/domain";
import type { Hex } from "viem";
import schema from "./schema";
import { api, internal } from "./_generated/api";

// Only the transaction queue is stubbed; every handler and the schema run unchanged.
vi.mock("./lib/relayer", () => {
  const pool = { enqueueAction: vi.fn(async () => "queued") };
  return { relayer: pool, agentPool: pool, lanePool: () => pool, laneOf: () => 0, laneCount: () => 1, MAX_LANES: 4 };
});
const modules = import.meta.glob(["./**/*.ts", "./**/*.js", "!./**/*.test.ts"]);

const NOW = Date.UTC(2026, 9, 16, 6);
const DAY = 86_400_000;
const SHOP = "0xCb4C82Dc556883c90eBd9a7440b096728a7A5fc6";
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function fixture(walletVersion?: number) {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity({ subject: "alice", issuer: "https://test.local", tokenIdentifier: "https://test.local|alice" });
  const stranger = t.withIdentity({ subject: "eve", issuer: "https://test.local", tokenIdentifier: "https://test.local|eve" });
  const alice = (await owner.mutation(api.users.ensure, {}))!;
  await stranger.mutation(api.users.ensure, {});
  const ids = await t.run(async (ctx) => {
    const agent = (name: string) =>
      ctx.db.insert("agents", {
        userId: alice, name, provider: "claude", status: "active", scopes: ["read", "prepare", "spend", "request"],
        dailyCapMinor: 5000, perPaymentMinor: 2000, spentTodayMinor: 0, hidesBalances: true, connectedAt: NOW, expiresAt: NOW + 30 * DAY,
      });
    const claude = await agent("Claude");
    const chatgpt = await agent("ChatGPT");
    const payee = await ctx.db.insert("payees", { userId: alice, name: "Blue Tokai", handle: "shop", kind: "merchant", trusted: true, address: SHOP, onchain: true });
    await ctx.db.insert("wallets", {
      userId: alice, address: walletVersion ? "0x5169E18E11682316978BDdc430a781f62d586284" : "", chain: "base-sepolia", asset: "USDC", balanceMinor: 25_000,
      protectedMinor: 5000, dailyCeilingMinor: 10_000, perPaymentMinor: 2000, frozen: false,
      ...(walletVersion ? { status: "live" as const, version: walletVersion } : {}),
    });
    return { claude, chatgpt, payee };
  });
  return { t, owner, stranger, alice, ...ids };
}

describe("a contact's daily limit for all agents", () => {
  it("counts every agent's payments to that contact, and asks the owner past it", async () => {
    const f = await fixture();
    await f.t.run((ctx) => ctx.db.patch(f.payee, { dailyCapMinor: 1000 }));
    const first = await f.t.mutation(internal.gateway.proposePayment, { agentId: f.claude, contactId: f.payee, amount: 6, reason: "beans" });
    expect(first.outcome).toBe("submitted");
    const second = await f.t.mutation(internal.gateway.proposePayment, { agentId: f.chatgpt, contactId: f.payee, amount: 6, reason: "more beans" });
    expect(second.outcome).toBe("needs_approval");
    expect((second as { reason: string }).reason).toContain("daily limit for all agents");
    // A day later the window has rolled.
    vi.setSystemTime(NOW + DAY + 1000);
    const later = await f.t.mutation(internal.gateway.proposePayment, { agentId: f.chatgpt, contactId: f.payee, amount: 6, reason: "tomorrow" });
    expect(later.outcome).toBe("submitted");
  });

  it("is only offered on a v3 vault", async () => {
    const f = await fixture(2);
    await expect(f.owner.mutation(api.vault.setContactCap, { payeeId: f.payee, dailyCapMinor: 1000 })).rejects.toThrow(/current vault/);
  });

  it("can't be set on someone else's contact", async () => {
    const f = await fixture(3);
    await expect(f.stranger.mutation(api.vault.setContactCap, { payeeId: f.payee, dailyCapMinor: 1000 })).rejects.toThrow(/Not found/);
  });

  it("asks for the passkey with the exact cap in the signed bytes; lowering counts at once, raising waits", async () => {
    const f = await fixture(3);
    await f.owner.mutation(api.vault.setContactCap, { payeeId: f.payee, dailyCapMinor: 1000 });
    const task = await f.t.run((ctx) => ctx.db.query("tasks").withIndex("by_user_state", (q) => q.eq("userId", f.alice).eq("state", "awaiting_approval")).first());
    expect(task!.action!.op).toBe(Op.AddContact);
    const shown = describeOp(Op.AddContact, task!.action!.data as Hex, {});
    expect(shown.lines).toContainEqual({ label: "All agents, per 24 hours", value: "$10.00" });
    expect(shown.lines).toContainEqual({ label: "Address", value: SHOP, mono: true });
    expect((await f.t.run((ctx) => ctx.db.get(f.payee)))!.dailyCapMinor).toBe(1000);

    await f.owner.mutation(api.vault.setContactCap, { payeeId: f.payee, dailyCapMinor: 5000 });
    expect((await f.t.run((ctx) => ctx.db.get(f.payee)))!.dailyCapMinor).toBe(1000);
  });
});
