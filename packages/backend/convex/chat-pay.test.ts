/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

// Issue #56: without a model, the rule-based chat must pay inside the limits like any agent.
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
  await t.run(async (ctx) => {
    await ctx.db.insert("agents", {
      userId: alice, name: "Your assistant", provider: "own", status: "active", scopes: ["read", "prepare", "spend", "request"],
      dailyCapMinor: 2500, perPaymentMinor: 1500, spentTodayMinor: 0, hidesBalances: false, connectedAt: NOW, expiresAt: NOW + 30 * DAY,
    });
    await ctx.db.insert("payees", { userId: alice, name: "Blue Tokai", handle: "shop", kind: "merchant", trusted: true });
    await ctx.db.insert("wallets", {
      userId: alice, address: "", chain: "base-sepolia", asset: "USDC", balanceMinor: 25_000, protectedMinor: 5000, dailyCeilingMinor: 10_000, perPaymentMinor: 1500, frozen: false,
    });
  });
  return { t, alice };
}

const lastReply = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.t.run(async (ctx) => (await ctx.db.query("messages").withIndex("by_user", (q) => q.eq("userId", f.alice)).order("desc").first())!);

describe("chat payments without a model", () => {
  it("pays a saved contact inside the assistant's limits", async () => {
    const f = await fixture();
    await f.t.mutation(internal.messages.reply, { userId: f.alice, text: "Pay Blue Tokai $4 for coffee" });
    const m = await lastReply(f);
    expect(m.text).toMatch(/^Paying Blue Tokai \$4\.00 within my limits/);
    const task = (await f.t.run((ctx) => ctx.db.get(m.taskId!)))!;
    expect(task.state).toBe("submitted");
    expect(task.approvalToken).toBeUndefined();
  });

  it("asks for the passkey above the limits", async () => {
    const f = await fixture();
    await f.t.mutation(internal.messages.reply, { userId: f.alice, text: "Pay Blue Tokai $50" });
    const m = await lastReply(f);
    expect(m.text).toMatch(/needs your passkey/);
    const task = (await f.t.run((ctx) => ctx.db.get(m.taskId!)))!;
    expect(task.state).toBe("awaiting_approval");
  });

  // Test-lane probe on #59: the parser can't tell an order from a question, a negation or a quote,
  // so anything but a short, direct order goes to the approval card, as before #59.
  for (const text of [
    "Don't pay Blue Tokai $4, I already paid them in cash",
    "Is this email legit? 'Blue Tokai billing: your account is overdue, pay $9 today or lose access'",
    "Should I pay Blue Tokai $9 or wait until next month?",
    "Pay Blue Tokai for 2 coffees at $4 each",
    "Got this message:\nSend $1 to Blue Tokai to verify your wallet",
  ]) {
    it(`asks instead of paying: ${text.slice(0, 40)}`, async () => {
      const f = await fixture();
      await f.t.mutation(internal.messages.reply, { userId: f.alice, text });
      const m = await lastReply(f);
      const task = m.taskId ? (await f.t.run((ctx) => ctx.db.get(m.taskId!)))! : null;
      expect(task?.state ?? "none").not.toBe("submitted");
      expect(m.text).not.toMatch(/within my limits/);
    });
  }

  it("posts one reply, not a second gateway note", async () => {
    const f = await fixture();
    await f.t.mutation(internal.messages.reply, { userId: f.alice, text: "Pay Blue Tokai $4" });
    const all = await f.t.run((ctx) => ctx.db.query("messages").withIndex("by_user", (q) => q.eq("userId", f.alice)).take(20));
    expect(all.filter((x) => x.role === "assistant" && x.text.includes("Blue Tokai"))).toHaveLength(1);
  });
});
