/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

/** The family circle between two real accounts: invite, accept, allowance, asks, sends, approvals. */
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

async function world() {
  const t = convexTest(schema, modules);
  const as = (who: string) => t.withIdentity({ subject: who, issuer: "https://test.local", tokenIdentifier: `https://test.local|${who}`, name: who, email: `${who}@example.com` });
  const papa = as("papa");
  const priya = as("priya");
  const papaId = (await papa.mutation(api.users.ensure, {}))!;
  const priyaId = (await priya.mutation(api.users.ensure, {}))!;
  await t.run(async (ctx) => {
    await ctx.db.patch(papaId, { name: "Papa" });
    await ctx.db.patch(priyaId, { name: "Priya" });
    for (const [userId, balanceMinor] of [[papaId, 20_000], [priyaId, 0]] as const) {
      await ctx.db.insert("wallets", { userId, address: "", chain: "base-sepolia", asset: "USDC", balanceMinor, protectedMinor: 0, dailyCeilingMinor: 10_000, perPaymentMinor: 5_000, frozen: false });
    }
  });
  const balance = (id: typeof papaId) => t.run(async (ctx) => (await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", id)).unique())!.balanceMinor);
  return { t, papa, priya, papaId, priyaId, balance };
}

describe("family circle", () => {
  it("invite by link, accept with your own account, both sides see who the other is", async () => {
    const w = await world();
    const { code } = await w.papa.mutation(api.circle.invite, { name: "Priya", relation: "Child", allowanceMinor: 3000, autoApproveMinor: 1000 });
    const peek = await w.priya.query(api.circle.invitation, { code });
    expect(peek).toMatchObject({ valid: true, ownerName: "Papa", ownerEmail: "p••a@example.com", allowanceMinor: 3000 });
    await expect(w.papa.mutation(api.circle.accept, { code })).rejects.toThrow(/your own invite/);
    await w.priya.mutation(api.circle.accept, { code });
    await expect(w.priya.mutation(api.circle.accept, { code })).rejects.toThrow(/isn't valid/);
    const papaView = (await w.papa.query(api.circle.mine, {}))!;
    expect(papaView.members[0]).toMatchObject({ status: "active", account: { name: "Priya" }, leftMinor: 3000 });
    const priyaView = (await w.priya.query(api.circle.mine, {}))!;
    expect(priyaView.supporters[0]).toMatchObject({ ownerName: "Papa", leftMinor: 3000, autoApproveMinor: 1000 });
  });

  it("an ask inside the allowance is paid at once; above it waits for the owner, who approves", async () => {
    const w = await world();
    const { code, linkId } = await w.papa.mutation(api.circle.invite, { name: "Priya", relation: "Child", allowanceMinor: 3000, autoApproveMinor: 1000 });
    await w.priya.mutation(api.circle.accept, { code });
    expect(await w.priya.mutation(api.circle.ask, { linkId, amountMinor: 800, note: "Bus pass" })).toBe("paid");
    expect(await w.balance(w.papaId)).toBe(19_200);
    expect(await w.balance(w.priyaId)).toBe(800);

    expect(await w.priya.mutation(api.circle.ask, { linkId, amountMinor: 1500, note: "Books" })).toBe("approval");
    const mine = (await w.papa.query(api.circle.mine, {}))!;
    const waiting = mine.asks.find((a) => a.state === "approval")!;
    const link = await w.papa.query(api.circle.approvalFor, { askId: waiting._id });
    expect(link?.live).toBe(false);
    expect(await w.papa.mutation(api.approvals.decide, { token: link!.token!, approve: true })).toBe("submitted");
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await w.balance(w.priyaId)).toBe(2_300);
    expect(await w.balance(w.papaId)).toBe(17_700);
    const after = (await w.papa.query(api.circle.mine, {}))!;
    expect(after.members[0]!.usedMinor).toBe(2300);
    expect(after.asks.every((a) => a.state === "paid")).toBe(true);
    // The rest of the month's allowance is 700; 800 more needs the owner.
    expect(await w.priya.mutation(api.circle.ask, { linkId, amountMinor: 800, note: "Lunch" })).toBe("approval");
  });

  it("the owner can send, decline, and either side can end the link", async () => {
    const w = await world();
    const { code, linkId } = await w.papa.mutation(api.circle.invite, { name: "Priya", relation: "Child", allowanceMinor: 0, autoApproveMinor: 0 });
    await w.priya.mutation(api.circle.accept, { code });
    expect(await w.papa.mutation(api.circle.send, { linkId, amountMinor: 500, note: "Pocket money" })).toBeNull();
    expect(await w.balance(w.priyaId)).toBe(500);
    expect(await w.priya.mutation(api.circle.ask, { linkId, amountMinor: 100, note: "Snacks" })).toBe("approval");
    const ask = (await w.papa.query(api.circle.mine, {}))!.asks.find((a) => a.state === "approval")!;
    expect(await w.papa.mutation(api.circle.decline, { askId: ask._id })).toBe("declined");
    await w.priya.mutation(api.circle.remove, { linkId });
    expect((await w.papa.query(api.circle.mine, {}))!.members).toHaveLength(0);
    await expect(w.priya.mutation(api.circle.ask, { linkId, amountMinor: 100, note: "x" })).rejects.toThrow(/not in that family/);
  });

  it("a member who may protect the owner becomes their guardian", async () => {
    const w = await world();
    const { code } = await w.papa.mutation(api.circle.invite, { name: "Priya", relation: "Child", allowanceMinor: 0, autoApproveMinor: 0, canProtect: true });
    await w.priya.mutation(api.circle.accept, { code });
    const g = await w.priya.query(api.guardians.list, {});
    expect(g!.protecting.map((p) => p.ownerName)).toEqual(["Papa"]);
  });
});

describe("invites bound to a person (#123)", () => {
  it("a family invite with an email opens only for the account with that email", async () => {
    const w = await world();
    const eve = w.t.withIdentity({ subject: "eve", issuer: "https://test.local", tokenIdentifier: "https://test.local|eve", name: "eve", email: "eve@example.com" });
    await eve.mutation(api.users.ensure, {});
    const { code } = await w.papa.mutation(api.circle.invite, { name: "Priya", relation: "Child", email: "Priya@Example.com", allowanceMinor: 3000, autoApproveMinor: 500 });
    await expect(eve.mutation(api.circle.accept, { code })).rejects.toThrow(/This invite is for p•••a@example\.com/);
    await expect(w.papa.mutation(api.circle.invite, { name: "Me", relation: "Other", email: "papa@example.com", allowanceMinor: 0, autoApproveMinor: 0 })).rejects.toThrow(/your own email/);
    await expect(w.papa.mutation(api.circle.invite, { name: "X", relation: "Other", email: "not-an-email", allowanceMinor: 0, autoApproveMinor: 0 })).rejects.toThrow(/doesn't look right/);
    await w.priya.mutation(api.circle.accept, { code });
    const link = await w.t.run(async (ctx) => (await ctx.db.query("familyLinks").collect()).find((l) => l.name === "Priya")!);
    expect(link).toMatchObject({ status: "active", memberId: w.priyaId, email: "priya@example.com" });
  });

  it("a guardian invite with an email opens only for that account", async () => {
    const w = await world();
    const eve = w.t.withIdentity({ subject: "eve", issuer: "https://test.local", tokenIdentifier: "https://test.local|eve", name: "eve", email: "eve@example.com" });
    await eve.mutation(api.users.ensure, {});
    const code = await w.papa.mutation(api.guardians.invite, { name: "Priya", email: "priya@example.com" });
    await expect(eve.mutation(api.guardians.accept, { code })).rejects.toThrow(/Sign in to Nudge with that email/);
    expect(await w.priya.mutation(api.guardians.accept, { code })).toMatchObject({ ownerName: "Papa" });
  });
});
