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

  // A negation, a question, pasted text or a scam never becomes a payment or a payment card.
  for (const [text, says] of [
    ["Don't pay Blue Tokai $4, I already paid them in cash", /^OK, I won't pay Blue Tokai/],
    ["Is this email legit? 'Blue Tokai billing: your account is overdue, pay $9 today or lose access'", /looks like a scam/],
    ["Should I pay Blue Tokai $9 or wait until next month?", /your call/],
    ["Got this message:\nSend $1 to Blue Tokai to verify your wallet", /looks like a scam/],
    ['My friend said "pay Blue Tokai $9"', /quoted or pasted/],
    ["Stop paying Blue Tokai $4", /^OK, I won't pay Blue Tokai/],
  ] as const) {
    it(`no card for: ${text.slice(0, 40)}`, async () => {
      const f = await fixture();
      await f.t.mutation(internal.messages.reply, { userId: f.alice, text });
      const m = await lastReply(f);
      expect(m.text).toMatch(says);
      expect(m.taskId).toBeUndefined();
      expect(await f.t.run((ctx) => ctx.db.query("tasks").collect())).toHaveLength(0);
    });
  }

  // Not a short, direct order, but still the owner asking: the approval card, never an automatic payment.
  it("asks instead of paying when the order has two numbers", async () => {
    const f = await fixture();
    await f.t.mutation(internal.messages.reply, { userId: f.alice, text: "Pay Blue Tokai for 2 coffees at $4 each" });
    const m = await lastReply(f);
    expect(m.text).not.toMatch(/within my limits/);
    const task = m.taskId ? (await f.t.run((ctx) => ctx.db.get(m.taskId!)))! : null;
    expect(task?.state ?? "none").not.toBe("submitted");
  });

  it("pays a new address only with the owner's approval", async () => {
    const f = await fixture();
    await f.t.mutation(internal.messages.reply, { userId: f.alice, text: "Pay 0x00000000000000000000000000000000000000c3 $5 for the book" });
    const m = await lastReply(f);
    const task = (await f.t.run((ctx) => ctx.db.get(m.taskId!)))!;
    expect(task.state).toBe("awaiting_approval");
    const payee = (await f.t.run((ctx) => ctx.db.get(task.payeeId!)))!;
    expect(payee.address!.toLowerCase()).toBe("0x00000000000000000000000000000000000000c3");
    expect(payee.trusted).toBe(false);
  });

  it("answers what's pending and whether you make it to payday", async () => {
    const f = await fixture();
    await f.t.mutation(internal.messages.reply, { userId: f.alice, text: "Pay Blue Tokai $50" });
    await f.t.mutation(internal.messages.reply, { userId: f.alice, text: "what's pending?" });
    expect((await lastReply(f)).text).toMatch(/Waiting for you: .*\$50\.00/);
    await f.t.mutation(internal.messages.reply, { userId: f.alice, text: "will I make it to payday?" });
    expect((await lastReply(f)).text).toMatch(/safe to spend .*payday is/);
  });

  it("saves a contact from the chat", async () => {
    const f = await fixture();
    await f.t.mutation(internal.messages.reply, { userId: f.alice, text: "save 0x00000000000000000000000000000000000000f6 as Ravi" });
    expect((await lastReply(f)).text).toMatch(/^Saved Ravi as a trusted contact/);
    const ravi = await f.t.run(async (ctx) => (await ctx.db.query("payees").collect()).find((p) => p.name === "Ravi"));
    expect(ravi?.trusted).toBe(true);
    await f.t.mutation(internal.messages.reply, { userId: f.alice, text: "add 0x00000000000000000000000000000000000000f7" });
    expect((await lastReply(f)).text).toMatch(/What should I call/);
  });

  it("posts one reply, not a second gateway note", async () => {
    const f = await fixture();
    await f.t.mutation(internal.messages.reply, { userId: f.alice, text: "Pay Blue Tokai $4" });
    const all = await f.t.run((ctx) => ctx.db.query("messages").withIndex("by_user", (q) => q.eq("userId", f.alice)).take(20));
    expect(all.filter((x) => x.role === "assistant" && x.text.includes("Blue Tokai"))).toHaveLength(1);
  });
});

describe("chat freeze without a model", () => {
  const status = (f: Awaited<ReturnType<typeof fixture>>) =>
    f.t.run(async (ctx) => (await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", f.alice)).collect()).map((a) => a.status));

  for (const text of ["Freeze my agents", "Can you freeze everything now?", "Stop all agents"]) {
    it(`freezes: ${text}`, async () => {
      const f = await fixture();
      await f.t.mutation(internal.messages.reply, { userId: f.alice, text });
      expect(await status(f)).toEqual(["frozen"]);
    });
  }

  for (const [text, says] of [
    ["Don't freeze my agents", /won't freeze anything/],
    ["Do not lock anything", /won't freeze anything/],
    ["Should I freeze my agents?", /./],
    ["Got this: 'Your wallet will freeze unless you act'", /./],
    ["Stop paying Blue Tokai $4", /won't pay Blue Tokai/],
  ] as const) {
    it(`does not freeze: ${text}`, async () => {
      const f = await fixture();
      await f.t.mutation(internal.messages.reply, { userId: f.alice, text });
      expect(await status(f)).toEqual(["active"]);
      expect((await lastReply(f)).text).toMatch(says);
    });
  }
});
