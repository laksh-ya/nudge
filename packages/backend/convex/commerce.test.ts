/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { pickOffer, purchaseView, testCardNumber } from "./lib/commerce";
import { storeAddress } from "./commerce";

/**
 * Agent commerce over MCP: an x402 purchase from Nudge's demo store (402 → vault payment → proof →
 * content), a price watch that buys when the price drops (AP2 human-not-present), replay
 * protection, and the agent tools beyond paying (pending, reminders, limit and contact requests).
 */
vi.mock("./lib/relayer", () => {
  const pool = { enqueueAction: vi.fn(async () => "queued") };
  return { relayer: pool, agentPool: pool, lanePool: () => pool, laneOf: () => 0, laneCount: () => 1, MAX_LANES: 4 };
});
const modules = import.meta.glob(["./**/*.ts", "./**/*.js", "!./**/*.test.ts"]);

const NOW = Date.UTC(2026, 9, 18, 6);
const DAY = 86_400_000;
const STORE = "https://store.test";
let t: ReturnType<typeof convexTest>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  // The agent's fetches to the store land on this deployment's own HTTP routes.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    // The store names itself by its own origin in the offer (convex-test calls it some.convex.site).
    if (url.origin !== STORE && url.host !== "some.convex.site") throw new Error(`unexpected fetch ${url}`);
    return await t.fetch(`${url.pathname}${url.search}`, { method: init?.method ?? "GET", headers: init?.headers });
  }) as typeof fetch;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  globalThis.fetch = realFetch;
});

async function world(opts: { perPayment?: number; trustStore?: boolean } = {}) {
  t = convexTest(schema, modules);
  const owner = t.withIdentity({ subject: "alice", issuer: "https://test.local", tokenIdentifier: "https://test.local|alice" });
  const alice = (await owner.mutation(api.users.ensure, {}))!;
  const agent = await t.run(async (ctx) => {
    await ctx.db.insert("wallets", { userId: alice, address: "", chain: "base-sepolia", asset: "USDC", balanceMinor: 25_000, protectedMinor: 5000, dailyCeilingMinor: 10_000, perPaymentMinor: 1500, frozen: false });
    if (opts.trustStore !== false) await ctx.db.insert("payees", { userId: alice, name: "Nudge demo store", handle: "store", kind: "merchant", trusted: true, address: storeAddress() });
    const per = opts.perPayment ?? 1000;
    return await ctx.db.insert("agents", {
      userId: alice, name: "Instinct", provider: "instinct", status: "active", scopes: per ? ["read", "prepare", "spend", "request"] : ["read", "prepare", "request"],
      dailyCapMinor: 2500, perPaymentMinor: per, spentTodayMinor: 0, hidesBalances: false, connectedAt: NOW, expiresAt: NOW + 30 * DAY,
    });
  });
  const settle = () => t.finishAllScheduledFunctions(vi.runAllTimers);
  const task = (id: string) => t.run((ctx) => ctx.db.get(id as Id<"tasks">));
  return { owner, alice, agent, settle, task };
}

describe("x402: buying from a site that answers 402", () => {
  it("pays inside the limits, proves it, and hands back what was bought", async () => {
    const w = await world();
    const r = (await t.action(internal.commerce.payX402, { agentId: w.agent, url: `${STORE}/x402/store/item?slug=coffee`, maxPrice: 5, requestId: "coffee-1" })) as Record<string, any>;
    expect(r).toMatchObject({ outcome: "submitted", price: "$4.00" });
    await w.settle();
    const status = await t.query(internal.gateway.taskStatus, { agentId: w.agent, taskId: r.taskId });
    expect(status.state).toBe("confirmed");
    expect(status.purchase).toMatchObject({ kind: "x402", merchant: "Nudge demo store" });
    expect(String(status.purchase!.resource)).toContain("NDG-COFFEE");
    // The same request id never buys twice.
    const again = (await t.action(internal.commerce.payX402, { agentId: w.agent, url: `${STORE}/x402/store/item?slug=coffee`, maxPrice: 5, requestId: "coffee-1" })) as Record<string, any>;
    expect(again.outcome).toBe("duplicate");
  });

  it("over the agent's own limit, the owner gets an approval link and nothing is bought yet", async () => {
    const w = await world({ perPayment: 300 });
    const r = (await t.action(internal.commerce.payX402, { agentId: w.agent, url: `${STORE}/x402/store/item?slug=coffee`, maxPrice: 5 })) as Record<string, any>;
    expect(r.outcome).toBe("needs_approval");
    expect(r.approvalUrl).toMatch(/\/a\//);
    expect((await w.task(r.taskId))!.purchase!.resource).toBeUndefined();
  });

  it("a merchant the owner never trusted needs the passkey too", async () => {
    const w = await world({ trustStore: false });
    const r = (await t.action(internal.commerce.payX402, { agentId: w.agent, url: `${STORE}/x402/store/item?slug=report`, maxPrice: 1 })) as Record<string, any>;
    expect(r).toMatchObject({ outcome: "needs_approval" });
    expect(r.reason).toMatch(/is a new payee, not a trusted contact/);
  });

  it("above maxPrice is refused before anything is created", async () => {
    const w = await world();
    const r = (await t.action(internal.commerce.payX402, { agentId: w.agent, url: `${STORE}/x402/store/item?slug=shoes`, maxPrice: 5 })) as Record<string, any>;
    expect(r).toMatchObject({ outcome: "refused", code: "2015" });
    expect(r.reason).toMatch(/\$12\.00, above your maxPrice/);
    expect(await t.run((ctx) => ctx.db.query("tasks").collect())).toHaveLength(0);
  });

  it("the store refuses a missing, forged or reused proof", async () => {
    await world();
    const first = await t.fetch("/x402/store/item?slug=api");
    expect(first.status).toBe(402);
    const offer = (await first.json()).accepts[0];
    expect(offer).toMatchObject({ scheme: "transfer", network: "base-sepolia", maxAmountRequired: "10000" });
    const forged = btoa(JSON.stringify({ x402Version: 1, scheme: "transfer", network: "base-sepolia", payload: { receipt: "x.1.1.deadbeef" } }));
    expect((await t.fetch("/x402/store/item?slug=api", { headers: { "X-PAYMENT": forged } })).status).toBe(402);
  });
});

describe("the test shop", () => {
  it("a person buys with checkout; the shop's order book shows the order, the buyer gets the goods", async () => {
    vi.stubEnv("CONVEX_SITE_URL", STORE);
    const w = await world();
    await t.run((ctx) => ctx.db.patch(w.alice, { name: "Aarav" }));
    const r = await w.owner.mutation(api.commerce.buyNow, { slug: "ticket" });
    expect(r.state).toBe("paid");
    await w.settle();
    const mine = await w.owner.query(api.commerce.myPurchases, {});
    expect(mine[0]).toMatchObject({ item: "Concert ticket, Saturday", state: "confirmed", by: "You" });
    expect(mine[0]!.resource).toContain("NDG-TKT");
    const book = await t.query(api.commerce.orders, {});
    expect(book[0]).toMatchObject({ slug: "ticket", buyer: "Aarav", via: "checkout", amountMinor: 1500 });
  });

  it("an agent's purchase is booked under the agent's name", async () => {
    const w = await world();
    await t.run((ctx) => ctx.db.patch(w.alice, { name: "Aarav" }));
    await t.action(internal.commerce.payX402, { agentId: w.agent, url: `${STORE}/x402/store/item?slug=book`, maxPrice: 5 });
    await w.settle();
    const book = await t.query(api.commerce.orders, {});
    expect(book[0]).toMatchObject({ slug: "book", buyer: "Instinct for Aarav", via: "x402" });
  });
});

describe("AP2 human-not-present: buy when the price drops", () => {
  it("watches, does nothing above the price, then buys once it drops", async () => {
    const w = await world();
    const r = await t.mutation(internal.commerce.watchPrice, { agentId: w.agent, url: `${STORE}/x402/store/item?slug=shoes`, item: "Trail shoes", maxPrice: 6 });
    expect(r.intent.natural_language_description).toMatch(/Buy Trail shoes at \$6\.00 or less/);
    await t.action(internal.commerce.checkWatch, { watchId: r.watchId });
    let watch = (await t.run((ctx) => ctx.db.get(r.watchId)))!;
    expect(watch).toMatchObject({ status: "active", lastPriceMinor: 1200 });
    expect(await t.run((ctx) => ctx.db.query("tasks").collect())).toHaveLength(0);

    const dropped = await t.fetch("/x402/store/price?slug=shoes&price=5.5", { method: "POST" });
    expect(await dropped.json()).toMatchObject({ price: "5.50" });
    await t.action(internal.commerce.checkWatch, { watchId: r.watchId });
    watch = (await t.run((ctx) => ctx.db.get(r.watchId)))!;
    expect(watch.status).toBe("bought");
    await w.settle();
    const task = (await w.task(watch.taskId!))!;
    expect(task).toMatchObject({ state: "confirmed", amountMinor: 550 });
    expect(task.purchase!.resource).toContain("NDG-SHOES");
    // Checking again never buys a second pair.
    await t.action(internal.commerce.checkWatch, { watchId: r.watchId });
    expect(await t.run((ctx) => ctx.db.query("tasks").collect())).toHaveLength(1);
  });
});

describe("one-time card", () => {
  it("is a payment like any other; the card details appear only once it's paid", async () => {
    const w = await world();
    await t.run(async (ctx) => ctx.db.insert("payees", { userId: w.alice, name: "Nudge cards (simulated)", handle: "cards", kind: "merchant", trusted: true, address: (await import("./commerce")).cardAddress() }));
    const r = (await t.mutation(internal.commerce.getCard, { agentId: w.agent, amount: 3, merchant: "Spotify", reason: "a month" })) as Record<string, any>;
    expect(r.outcome).toBe("submitted");
    const before = await t.query(internal.gateway.taskStatus, { agentId: w.agent, taskId: r.taskId });
    expect((before.purchase as { card?: object }).card).not.toHaveProperty("number");
    await w.settle();
    const after = await t.query(internal.gateway.taskStatus, { agentId: w.agent, taskId: r.taskId });
    expect(((after.purchase as { card?: { number: string } }).card)!.number).toMatch(/^424242\d{10}$/);
  });
});

describe("agent tools beyond paying", () => {
  it("sets and lists a reminder, and shows pending approvals with their links", async () => {
    const w = await world({ perPayment: 0 });
    const rem = await t.mutation(internal.agentTools.setReminder, { agentId: w.agent, text: "Pay rent", at: "2026-11-01", repeat: "monthly" });
    expect(rem).toMatchObject({ text: "Pay rent", repeat: "monthly" });
    expect(rem.at.slice(0, 10)).toBe("2026-11-01");
    const list = await t.query(internal.agentTools.reminders, { agentId: w.agent });
    expect(list.reminders.map((x) => x.text)).toEqual(["Pay rent"]);
    await expect(t.mutation(internal.agentTools.setReminder, { agentId: w.agent, text: "x", at: "yesterday" })).rejects.toThrow(/ISO date-time/);

    const payee = await t.run((ctx) => ctx.db.query("payees").first());
    await t.mutation(internal.gateway.proposePayment, { agentId: w.agent, contactId: payee!._id, amount: 2, reason: "tea" });
    const p = await t.query(internal.agentTools.pending, { agentId: w.agent });
    expect(p.waitingForApproval).toHaveLength(1);
    expect(p.waitingForApproval[0]!.approvalUrl).toMatch(/^https:\/\/nudge-approve\.vercel\.app\/a\//);
    expect(p.reminders).toHaveLength(1);
  });

  it("asks for higher limits with a link; the owner's yes applies them; lower limits apply at once", async () => {
    const w = await world({ perPayment: 0 });
    const r = (await t.mutation(internal.agentTools.requestLimits, { agentId: w.agent, perPayment: 2, perDay: 10, why: "small API calls" })) as Record<string, any>;
    expect(r.outcome).toBe("needs_approval");
    const token = String(r.approvalUrl).split("/a/")[1]!;
    // The link alone can't approve: only the signed-in owner (or their passkey on a live vault).
    await expect(t.mutation(api.approvals.decide, { token, approve: true })).rejects.toThrow(/Not signed in/);
    expect(await w.owner.mutation(api.approvals.decide, { token, approve: true })).toBe("confirmed");
    const agent = (await t.run((ctx) => ctx.db.get(w.agent)))!;
    expect(agent).toMatchObject({ perPaymentMinor: 200, dailyCapMinor: 1000 });
    expect(agent.scopes).toContain("spend");
    const lower = (await t.mutation(internal.agentTools.requestLimits, { agentId: w.agent, perPayment: 1, perDay: 5, why: "less" })) as Record<string, any>;
    expect(lower.outcome).toBe("applied");
    expect((await t.run((ctx) => ctx.db.get(w.agent)))!.perPaymentMinor).toBe(100);
  });

  it("adds bills and plan items the plan and reminders then use", async () => {
    const w = await world();
    const bill = await t.mutation(internal.agentTools.addBill, { agentId: w.agent, name: "Rent", amount: 18000, due: "2026-11-01" });
    expect(bill).toMatchObject({ name: "Rent", nextDue: "2026-11-01", repeats: "monthly" });
    await expect(t.mutation(internal.agentTools.addBill, { agentId: w.agent, name: "Gym", amount: 20, due: "2026-11-01", payWith: "wallet" })).rejects.toThrow(/needs contactId/);
    const salary = await t.mutation(internal.agentTools.addPlan, { agentId: w.agent, kind: "income", name: "Salary", amount: 90000, date: "2026-10-31", repeats: "monthly" });
    expect(salary).toMatchObject({ name: "Salary", repeats: "monthly" });
    const plan = await t.query(internal.agentTools.plan, { agentId: w.agent });
    expect(plan.expectedIn.map((x) => x.name)).toEqual(["Salary"]);
  });

  it("saves a new contact only with the owner's approval", async () => {
    const w = await world();
    const r = (await t.mutation(internal.agentTools.addContact, { agentId: w.agent, name: "Corner Café", address: "0x00000000000000000000000000000000000000d4", kind: "merchant" })) as Record<string, any>;
    expect(r.outcome).toBe("needs_approval");
    expect((await t.run((ctx) => ctx.db.get(r.contactId as Id<"payees">)))!.trusted).toBe(false);
    await w.owner.mutation(api.approvals.decide, { token: String(r.approvalUrl).split("/a/")[1]!, approve: true });
    expect((await t.run((ctx) => ctx.db.get(r.contactId as Id<"payees">)))!.trusted).toBe(true);
  });
});

describe("pure helpers", () => {
  it("pays only transfer offers on base-sepolia in the wallet's token, in whole cents", () => {
    const token = "0xB0ee01235A8e7903519B029c1530332f5847D932";
    const base = { network: "base-sepolia", payTo: "0x1", asset: token };
    expect(pickOffer({ x402Version: 1, accepts: [{ ...base, scheme: "transfer", maxAmountRequired: "40000" }] }, token)).toMatchObject({ cents: 4 });
    expect(pickOffer({ x402Version: 1, accepts: [{ ...base, scheme: "exact", maxAmountRequired: "40000" }] }, token)).toMatchObject({ problem: expect.stringMatching(/vault wallet can't give/) });
    expect(pickOffer({ x402Version: 1, accepts: [{ ...base, scheme: "transfer", maxAmountRequired: "12345" }] }, token)).toMatchObject({ problem: expect.stringMatching(/whole number of cents/) });
  });
  it("test card numbers pass the Luhn check and never leave the test range", () => {
    for (const seed of ["a", "b", "task123"]) {
      const n = testCardNumber(seed);
      expect(n).toMatch(/^424242\d{10}$/);
      const sum = [...n].reverse().reduce((s, c, i) => s + (i % 2 ? (Number(c) * 2 > 9 ? Number(c) * 2 - 9 : Number(c) * 2) : Number(c)), 0);
      expect(sum % 10).toBe(0);
    }
    expect((purchaseView({ kind: "card", card: { number: "4242424242424242", exp: "11/26", cvc: "123", last4: "4242" } }, "submitted") as { card?: object }).card).toEqual(expect.not.objectContaining({ number: expect.anything() }));
  });
});
