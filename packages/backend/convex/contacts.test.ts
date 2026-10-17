/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Op, describe as describeOp } from "@agent-wallet/domain";
import type { Hex } from "viem";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

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

describe("contacts the owner adds and removes (#10)", () => {
  const NEW = "0x1111111111111111111111111111111111111111";
  const VAULT_STATE = {
    version: 3, protectedMinor: 5000, ceilingMinor: 10_000, contactDelay: 86_400, changeDelay: 120, holdAboveMinor: 500, holdFor: 120,
    frozen: false, balanceMinor: 25_000, heldMinor: 0, spentMinor: 0, headroomMinor: 10_000, ownerKeys: 1, syncedAt: NOW,
  };

  async function live() {
    const f = await fixture(3);
    await f.t.run(async (ctx) => {
      const w = (await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", f.alice)).unique())!;
      await ctx.db.patch(w._id, { vault: VAULT_STATE, keyId: `0x${"11".repeat(32)}` });
      await ctx.db.patch(f.claude, {
        onchain: true, chainAddress: "0x00000000000000000000000000000000000000a1",
        vault: { perPaymentMinor: 2000, dailyCapMinor: 5000, expiresAt: NOW + 30 * DAY, active: true, frozen: false, strikes: 0, spentMinor: 0, syncedAt: NOW },
      });
    });
    return f;
  }
  const pay = (f: Awaited<ReturnType<typeof fixture>>, contactId: string) =>
    f.t.mutation(internal.gateway.proposePayment, { agentId: f.claude, contactId, amount: 3, reason: "test" });

  it("on a simulated wallet, works at once and agents can pay it", async () => {
    const f = await fixture();
    const { payeeId, token } = await f.owner.mutation(api.contacts.add, { name: "Test Shop", address: NEW.toLowerCase(), kind: "merchant" });
    expect(token).toBeNull();
    const p = (await f.t.run((ctx) => ctx.db.get(payeeId)))!;
    expect(p).toMatchObject({ trusted: true, address: NEW, onchain: false });
    expect((await pay(f, payeeId)).outcome).toBe("submitted");
  });

  it("refuses a bad address, a duplicate, or someone else's call", async () => {
    const f = await fixture();
    await expect(f.owner.mutation(api.contacts.add, { name: "X", address: "0x1234" })).rejects.toThrow(/wallet address/);
    await expect(f.owner.mutation(api.contacts.add, { name: "X", address: "0xcB4C82Dc556883c90eBd9a7440b096728a7A5fc6" })).rejects.toThrow(/checksum/);
    await expect(f.owner.mutation(api.contacts.add, { name: "Copy", address: SHOP })).rejects.toThrow(/already saved as Blue Tokai/);
    await expect(f.stranger.mutation(api.contacts.remove, { payeeId: f.payee })).rejects.toThrow(/Not found/);
  });

  it("on a live vault, needs the passkey and the vault's waiting period; agents are refused until then", async () => {
    const f = await live();
    const { payeeId, token } = await f.owner.mutation(api.contacts.add, { name: "Test Shop", address: NEW });
    expect(token).toBeTruthy();
    const task = await f.t.run((ctx) => ctx.db.query("tasks").withIndex("by_approval_token", (q) => q.eq("approvalToken", token!)).unique());
    expect(task!.action!.op).toBe(Op.AddContact);
    const shown = describeOp(Op.AddContact, task!.action!.data as Hex, {});
    expect(shown.lines).toContainEqual({ label: "Agents can pay", value: "After the waiting period" });
    expect(shown.lines).toContainEqual({ label: "Address", value: NEW, mono: true });
    // The same link again while it's open.
    expect(await f.owner.mutation(api.contacts.approveAdd, { payeeId })).toBe(token);

    const early = await pay(f, payeeId);
    expect(early).toMatchObject({ outcome: "refused", code: "2002" });
    expect((early as { reason: string }).reason).toContain("passkey");

    // The vault applied it: the waiting period starts now.
    await f.t.mutation(internal.vault.onOwnerResult, { taskId: task!._id, ok: true, txHash: `0x${"cd".repeat(32)}` });
    const added = (await f.t.run((ctx) => ctx.db.get(payeeId)))!;
    expect(added).toMatchObject({ onchain: true, trusted: true, activeAt: NOW + DAY });
    expect(added.pendingPasskey).toBeUndefined();
    expect(await pay(f, payeeId)).toMatchObject({ outcome: "refused", code: "2002" });

    vi.setSystemTime(NOW + DAY + 1000);
    expect((await pay(f, payeeId)).outcome).toBe("submitted");
  });

  it("removal is instant in the app, cancels waiting requests and offers the vault removal", async () => {
    const f = await live();
    const asked = await f.t.mutation(internal.gateway.proposePayment, { agentId: f.claude, contactId: f.payee, amount: 30, reason: "too big" });
    expect(asked.outcome).toBe("needs_approval");
    const { token } = await f.owner.mutation(api.contacts.remove, { payeeId: f.payee });
    expect(await f.t.run((ctx) => ctx.db.get(f.payee))).toBeNull();
    expect((await f.t.run((ctx) => ctx.db.get((asked as { taskId: Id<"tasks"> }).taskId)))!.state).toBe("cancelled");
    const removal = await f.t.run((ctx) => ctx.db.query("tasks").withIndex("by_approval_token", (q) => q.eq("approvalToken", token!)).unique());
    expect(removal!.action!.op).toBe(Op.RemoveContact);
    expect(await pay(f, f.payee)).toMatchObject({ outcome: "refused", code: "2010" });
  });

  it("a pending contact removed before approval is never marked as added", async () => {
    const f = await live();
    const { payeeId, token } = await f.owner.mutation(api.contacts.add, { name: "Test Shop", address: NEW });
    const task = await f.t.run((ctx) => ctx.db.query("tasks").withIndex("by_approval_token", (q) => q.eq("approvalToken", token!)).unique());
    const removed = await f.owner.mutation(api.contacts.remove, { payeeId });
    expect(removed.token).toBeNull();
    expect((await f.t.run((ctx) => ctx.db.get(task!._id)))!.state).toBe("cancelled");
  });
});

describe("declining from the approval page", () => {
  it("cancels with the link alone and is idempotent", async () => {
    const f = await fixture();
    const asked = await f.t.mutation(internal.gateway.proposePayment, { agentId: f.claude, contactId: f.payee, amount: 30, reason: "too big" });
    const task = (await f.t.run((ctx) => ctx.db.get((asked as { taskId: Id<"tasks"> }).taskId)))!;
    expect(await f.t.mutation(api.approvals.decline, { token: task.approvalToken! })).toBe("cancelled");
    expect(await f.t.mutation(api.approvals.decline, { token: task.approvalToken! })).toBe("cancelled");
    await expect(f.t.mutation(api.approvals.decline, { token: "x".repeat(24) })).rejects.toThrow(/no longer valid/);
  });
});
