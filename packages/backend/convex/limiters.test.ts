/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

// Issue #9: limits that must actually count, and outcomes that must not claim more than is known.
vi.mock("./lib/relayer", () => {
  const pool = { enqueueAction: vi.fn(async () => "queued") };
  return { relayer: pool, agentPool: pool, lanePool: () => pool, laneOf: () => 0, laneCount: () => 1, MAX_LANES: 4 };
});
const modules = import.meta.glob(["./**/*.ts", "./**/*.js", "!./**/*.test.ts"]);

const NOW = Date.UTC(2026, 9, 16, 6);
const DAY = 86_400_000;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function fixture() {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity({ subject: "alice", issuer: "https://test.local", tokenIdentifier: "https://test.local|alice" });
  const alice = (await owner.mutation(api.users.ensure, {}))!;
  const ids = await t.run(async (ctx) => {
    const agent = await ctx.db.insert("agents", {
      userId: alice, name: "Claude", provider: "claude", status: "active", scopes: ["read", "prepare", "spend", "request"],
      dailyCapMinor: 5000, perPaymentMinor: 2000, spentTodayMinor: 0, hidesBalances: true, connectedAt: NOW, expiresAt: NOW + 30 * DAY,
    });
    const payee = await ctx.db.insert("payees", { userId: alice, name: "Landlord", handle: "landlord@upi", kind: "person", trusted: true });
    const wallet = await ctx.db.insert("wallets", {
      userId: alice, address: "", chain: "base-sepolia", asset: "USDC", balanceMinor: 25_000, protectedMinor: 5000, dailyCeilingMinor: 10_000, perPaymentMinor: 2000, frozen: false,
    });
    return { agent, payee, wallet };
  });
  return { t, owner, alice, ...ids };
}

describe("passkey confirmation codes", () => {
  it("counts wrong codes, so the sixth guess is blocked even with the right code", async () => {
    const f = await fixture();
    await f.t.run((ctx) =>
      ctx.db.patch(f.wallet, {
        enrolExpiresAt: NOW + 600_000,
        candidate: { x: `0x${"aa".repeat(32)}`, y: `0x${"bb".repeat(32)}`, credentialId: "c", rpId: "agent-wallet-approve.vercel.app", code: "123456", purpose: "backup", device: "Phone", at: NOW },
      }),
    );
    for (let i = 0; i < 5; i++) {
      expect((await f.owner.mutation(api.vault.confirmEnrol, { code: `00000${i}` })).error).toMatch(/doesn't match/);
    }
    expect((await f.owner.mutation(api.vault.confirmEnrol, { code: "123456" })).error).toMatch(/Too many wrong codes/);
  });
});

describe("assistant payments", () => {
  it.each([0.004, 0.001, 1.005, 2.999])("refuses $%s: amounts are whole cents", async (amount) => {
    const f = await fixture();
    const r = await f.t.mutation(internal.gateway.proposePayment, { agentId: f.agent, contactId: f.payee, amount, reason: "tiny" });
    expect(r.outcome).toBe("refused");
    expect(await f.t.run((ctx) => ctx.db.query("tasks").take(10))).toHaveLength(0);
  });

  it("counts every call in an MCP batch against the per-minute limit", async () => {
    const f = await fixture();
    for (let i = 0; i < 12; i++) expect(await f.t.mutation(internal.gateway.allow, { agentId: f.agent, calls: 5 })).toBe(true);
    // 60 calls used: the next batch, and even a single call, is refused.
    expect(await f.t.mutation(internal.gateway.allow, { agentId: f.agent, calls: 5 })).toBe(false);
    expect(await f.t.mutation(internal.gateway.allow, { agentId: f.agent })).toBe(false);
  });
});

describe("UPI handoffs", () => {
  it("are marked as reported by the owner, never as paid", async () => {
    const f = await fixture();
    const taskId = await f.t.run((ctx) =>
      ctx.db.insert("tasks", {
        userId: f.alice, title: "Rent", channel: "app", payeeId: f.payee, amountMinor: 2_500_000, currency: "INR",
        state: "awaiting_approval", rail: "handoff", approvalToken: "abcdefghijklmnopqrstuvwx", expiresAt: NOW + 600_000, updatedAt: NOW,
      }),
    );
    await f.owner.mutation(api.approvals.decide, { token: "abcdefghijklmnopqrstuvwx", approve: true });
    await f.t.mutation(internal.tasks.settle, { taskId });
    const task = (await f.t.run((ctx) => ctx.db.get(taskId)))!;
    expect(task.state).toBe("reported");
    expect(task.reason).toMatch(/hasn't confirmed/);
    const said = await f.t.run((ctx) => ctx.db.query("messages").withIndex("by_user", (q) => q.eq("userId", f.alice)).take(50));
    expect(said.map((m) => m.text).join(" ")).not.toMatch(/has been paid/);
  });
});
