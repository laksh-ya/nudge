/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

/** Wallet → Rules and limits: every rule editable; a simulated wallet applies them at once. */
vi.mock("./lib/relayer", () => {
  const pool = { enqueueAction: vi.fn(async () => "queued") };
  return { relayer: pool, agentPool: pool, lanePool: () => pool, laneOf: () => 0, laneCount: () => 1, MAX_LANES: 4 };
});
const modules = import.meta.glob(["./**/*.ts", "./**/*.js", "!./**/*.test.ts"]);
const NOW = Date.UTC(2026, 9, 18, 6);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("rules and limits", () => {
  it("are all editable, validated, and the new-contact wait applies to agents", async () => {
    const t = convexTest(schema, modules);
    const o = t.withIdentity({ subject: "a", issuer: "https://test.local", tokenIdentifier: "https://test.local|a" });
    const me = (await o.mutation(api.users.ensure, {}))!;
    const agent = await t.run(async (ctx) => {
      await ctx.db.insert("wallets", { userId: me, address: "", chain: "base-sepolia", asset: "USDC", balanceMinor: 20_000, protectedMinor: 0, dailyCeilingMinor: 5000, perPaymentMinor: 1000, frozen: false });
      return await ctx.db.insert("agents", { userId: me, name: "Claude", provider: "claude", status: "active", scopes: ["read", "prepare", "spend", "request"], dailyCapMinor: 2000, perPaymentMinor: 1000, spentTodayMinor: 0, hidesBalances: false, connectedAt: NOW, expiresAt: NOW + 30 * 86_400_000 });
    });
    const base = { dailyCeilingMinor: 8000, protectedMinor: 2000, perPaymentMinor: 1500, holdAboveMinor: 500, holdFor: 600, contactDelay: 3600, changeDelay: 600 };
    expect(await o.mutation(api.wallet.setRules, base)).toBeNull();
    expect(await o.query(api.wallet.rules, {})).toMatchObject({ live: false, ...base });
    await expect(o.mutation(api.wallet.setRules, { ...base, perPaymentMinor: 9000 })).rejects.toThrow(/can't be more than the daily limit/);
    await expect(o.mutation(api.wallet.setRules, { ...base, changeDelay: 5 })).rejects.toThrow(/1 minute to 7 days/);

    const { payeeId } = await o.mutation(api.contacts.add, { name: "New Cafe", address: "0x00000000000000000000000000000000000000e5" });
    const early = await t.mutation(internal.gateway.proposePayment, { agentId: agent, contactId: payeeId, amount: 2, reason: "coffee" });
    expect(early.outcome).toBe("needs_approval");
    vi.setSystemTime(NOW + 3601_000);
    const later = await t.mutation(internal.gateway.proposePayment, { agentId: agent, contactId: payeeId, amount: 2, reason: "coffee" });
    expect(later.outcome).toBe("submitted");
  });

  it("an agent limited to certain contacts asks for anyone else", async () => {
    const t = convexTest(schema, modules);
    const o = t.withIdentity({ subject: "b", issuer: "https://test.local", tokenIdentifier: "https://test.local|b" });
    const me = (await o.mutation(api.users.ensure, {}))!;
    const { agent, cafe, shop } = await t.run(async (ctx) => {
      await ctx.db.insert("wallets", { userId: me, address: "", chain: "base-sepolia", asset: "USDC", balanceMinor: 20_000, protectedMinor: 0, dailyCeilingMinor: 5000, perPaymentMinor: 1000, frozen: false });
      const cafe = await ctx.db.insert("payees", { userId: me, name: "Cafe", handle: "c", kind: "merchant", trusted: true });
      const shop = await ctx.db.insert("payees", { userId: me, name: "Shop", handle: "s", kind: "merchant", trusted: true });
      const agent = await ctx.db.insert("agents", { userId: me, name: "Claude", provider: "claude", status: "active", scopes: ["read", "prepare", "spend", "request"], dailyCapMinor: 2000, perPaymentMinor: 1000, spentTodayMinor: 0, hidesBalances: false, connectedAt: NOW, expiresAt: NOW + 30 * 86_400_000 });
      return { agent, cafe, shop };
    });
    await o.mutation(api.gateway.updateGrant, { agentId: agent, scopes: ["read", "prepare", "spend", "request"], dailyCapMinor: 2000, perPaymentMinor: 1000, hidesBalances: false, days: 30, allowedPayees: [cafe] });
    expect((await t.mutation(internal.gateway.proposePayment, { agentId: agent, contactId: cafe, amount: 2, reason: "x" })).outcome).toBe("submitted");
    const other = await t.mutation(internal.gateway.proposePayment, { agentId: agent, contactId: shop, amount: 2, reason: "x" });
    expect(other).toMatchObject({ outcome: "needs_approval" });
    expect((other as { reason: string }).reason).toMatch(/isn't on Claude's list/);
  });
});
