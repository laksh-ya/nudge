/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

// A family guardian: sees held payments and assistant requests, can stop them, can never pay or loosen.
const sent: unknown[] = [];
vi.mock("./lib/relayer", () => {
  const pool = { enqueueAction: vi.fn(async (_c: unknown, fn: unknown, args: unknown) => (sent.push({ fn, args }), "queued")) };
  return { relayer: pool, agentPool: pool, lanePool: () => pool, laneOf: () => 0, laneCount: () => 1, MAX_LANES: 4 };
});
const modules = import.meta.glob(["./**/*.ts", "./**/*.js", "!./**/*.test.ts"]);

async function family() {
  const t = convexTest(schema, modules);
  const as = (s: string) => t.withIdentity({ subject: s, issuer: "https://test.local", tokenIdentifier: `https://test.local|${s}` });
  const grandma = as("grandma");
  const daughter = as("daughter");
  const stranger = as("stranger");
  const g = (await grandma.mutation(api.users.ensure, {}))!;
  await daughter.mutation(api.users.ensure, {});
  await stranger.mutation(api.users.ensure, {});
  const ids = await t.run(async (ctx) => {
    const agent = await ctx.db.insert("agents", {
      userId: g, name: "Claude", provider: "claude", status: "active", scopes: ["read", "prepare", "spend", "request"],
      dailyCapMinor: 2500, perPaymentMinor: 1500, spentTodayMinor: 0, hidesBalances: true, connectedAt: Date.now(), expiresAt: Date.now() + 86_400_000,
    });
    const payee = await ctx.db.insert("payees", { userId: g, name: "Prize Office", handle: "x", kind: "merchant", trusted: true });
    const held = await ctx.db.insert("tasks", {
      userId: g, title: "Claim your prize", channel: "mcp", agentId: agent, payeeId: payee, amountMinor: 900, currency: "USDC",
      state: "held", rail: "base-sepolia", paymentId: `0x${"11".repeat(32)}`, releaseAt: Date.now() + 30 * 60_000, updatedAt: Date.now(),
    });
    return { agent, payee, held };
  });
  return { t, grandma, daughter, stranger, g, ...ids };
}

async function linked() {
  const f = await family();
  const code = await f.grandma.mutation(api.guardians.invite, { name: "Priya" });
  await f.daughter.mutation(api.guardians.accept, { code });
  return f;
}

describe("family guardian", () => {
  it("links with a one-use code, then sees held payments without balances", async () => {
    const f = await family();
    const code = await f.grandma.mutation(api.guardians.invite, { name: "Priya (daughter)" });
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    await f.daughter.mutation(api.guardians.accept, { code });
    await expect(f.stranger.mutation(api.guardians.accept, { code })).rejects.toThrow(/isn't valid/);
    const view = (await f.daughter.query(api.guardians.watch, { ownerId: f.g }))!;
    expect(view.held).toHaveLength(1);
    expect(view.held[0]).toMatchObject({ agent: "Claude", payee: "Prize Office", amount: "$9.00", state: "held" });
    expect(JSON.stringify(view)).not.toMatch(/balance/i);
  });

  it("can stop a held payment, which goes to the vault's cancel; a stranger can't see or stop it", async () => {
    const f = await linked();
    expect(await f.stranger.query(api.guardians.watch, { ownerId: f.g })).toBeNull();
    await expect(f.stranger.mutation(api.guardians.cancelHeld, { taskId: f.held })).rejects.toThrow(/Not found/);
    sent.length = 0;
    await f.daughter.mutation(api.guardians.cancelHeld, { taskId: f.held });
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain(f.held);
    const activity = await f.t.run((ctx) => ctx.db.query("activity").withIndex("by_user", (q) => q.eq("userId", f.g)).collect());
    expect(activity.some((a) => a.title === "Priya stopped a held payment")).toBe(true);
  });

  it("can only stop held payments, and has no way to approve, pay or change limits", async () => {
    const f = await linked();
    await f.t.run((ctx) => ctx.db.patch(f.held, { state: "confirmed" }));
    await expect(f.daughter.mutation(api.guardians.cancelHeld, { taskId: f.held })).rejects.toThrow(/Only a held payment/);
    // The owner's own controls stay the owner's: the guardian's account owns none of these records.
    await expect(f.daughter.mutation(api.vault.cancelWaiting, { taskId: f.held })).rejects.toThrow(/Not found/);
    await expect(
      f.daughter.mutation(api.gateway.updateGrant, { agentId: f.agent, scopes: ["read", "spend"], dailyCapMinor: 99_900, perPaymentMinor: 99_900, hidesBalances: false, days: 30 }),
    ).rejects.toThrow(/Not found/);
  });

  it("can freeze the assistants; unfreezing stays with the owner", async () => {
    const f = await linked();
    expect(await f.daughter.mutation(api.guardians.freeze, { ownerId: f.g })).toBeGreaterThan(0);
    expect((await f.t.run((ctx) => ctx.db.get(f.agent)))!.status).toBe("frozen");
    await expect(f.daughter.mutation(api.agents.setStatus, { agentId: f.agent, status: "active" })).rejects.toThrow(/Not found/);
  });

  it("is told when a payment is held", async () => {
    const f = await linked();
    const task = await f.t.run((ctx) =>
      ctx.db.insert("tasks", { userId: f.g, title: "Gift card", channel: "mcp", agentId: f.agent, payeeId: f.payee, amountMinor: 700, currency: "USDC", state: "submitted", rail: "base-sepolia", updatedAt: Date.now() }),
    );
    await f.t.mutation(internal.vault.onHeld, { taskId: task, txHash: `0x${"22".repeat(32)}`, releaseAt: Date.now() + 30 * 60_000 });
    const daughterId = (await f.t.run((ctx) => ctx.db.query("guardians").collect()))[0]!.guardianId as Id<"users">;
    const alerts = await f.t.run((ctx) => ctx.db.query("activity").withIndex("by_user", (q) => q.eq("userId", daughterId)).collect());
    expect(alerts.some((a) => /Claude is paying Prize Office \$7\.00; it's held/.test(a.title))).toBe(true);
  });

  it("loses access the moment the owner removes them; nobody is their own guardian; codes expire", async () => {
    const f = await family();
    const code = await f.grandma.mutation(api.guardians.invite, { name: "Priya" });
    await expect(f.grandma.mutation(api.guardians.accept, { code })).rejects.toThrow(/own guardian/);
    await f.daughter.mutation(api.guardians.accept, { code });
    const link = (await f.grandma.query(api.guardians.list, {}))!.guardians[0]!;
    await f.grandma.mutation(api.guardians.remove, { linkId: link._id });
    expect(await f.daughter.query(api.guardians.watch, { ownerId: f.g })).toBeNull();
    await expect(f.daughter.mutation(api.guardians.cancelHeld, { taskId: f.held })).rejects.toThrow(/Not found/);
    const late = await f.grandma.mutation(api.guardians.invite, { name: "Ravi" });
    await f.t.run(async (ctx) => {
      const row = (await ctx.db.query("guardians").collect()).find((g) => g.code === late)!;
      await ctx.db.patch(row._id, { codeExpiresAt: Date.now() - 1 });
    });
    await expect(f.stranger.mutation(api.guardians.accept, { code: late })).rejects.toThrow(/isn't valid/);
  });

  it("extra protection needs the on-chain vault", async () => {
    const f = await family();
    await expect(f.grandma.mutation(api.guardians.protectMore, { holdMinutes: 30 })).rejects.toThrow(/on-chain/);
  });
});
