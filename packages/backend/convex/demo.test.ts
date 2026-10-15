/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { ASSISTANT_TURNS, VISITOR_DEPLOYS_PER_DAY } from "./lib/budget";
import { JUDGE_READ_ONLY } from "./lib/auth";

vi.mock("./lib/relayer", () => ({ relayer: { enqueueAction: vi.fn(async () => "queued") } }));
const modules = import.meta.glob(["./**/*.ts", "./**/*.js", "!./**/*.test.ts"]);

const NOW = Date.UTC(2026, 9, 16, 6);
const ISSUER = "https://demo.agent-wallet.app";
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env.RELAYER_PRIVATE_KEY = `0x${"11".repeat(32)}`;
  process.env.FACTORY_ADDRESS = "0x672DcD9A822030371d017673403edc290c9d8975";
  process.env.TOKEN_ADDRESS = "0xB0ee01235A8e7903519B029c1530332f5847D932";
  process.env.AGENT_KEY_SECRET = "test-secret";
});
afterEach(() => vi.useRealTimers());

const sandbox = (t: ReturnType<typeof convexTest>, sub: string, vis = "ab".repeat(16)) =>
  t.withIdentity({ subject: sub, issuer: ISSUER, tokenIdentifier: `${ISSUER}|${sub}`, vis });

/** A sandbox whose passkey is enrolled and confirmed, so the next confirm deploys. */
async function readyToDeploy(t: ReturnType<typeof convexTest>, who: ReturnType<typeof sandbox>) {
  const userId = (await who.mutation(api.users.ensure, {}))!;
  await t.run(async (ctx) => {
    const w = (await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", userId)).unique())!;
    await ctx.db.patch(w._id, {
      status: undefined,
      deployRequestedAt: undefined,
      enrolExpiresAt: NOW + 600_000,
      candidate: { x: `0x${"aa".repeat(32)}`, y: `0x${"bb".repeat(32)}`, credentialId: "c", rpId: "agent-wallet-approve.vercel.app", code: "123456", purpose: "first", device: "Phone", at: NOW },
    });
  });
  return userId;
}

describe("demo deploy budgets", () => {
  it(`lets one visitor make ${VISITOR_DEPLOYS_PER_DAY} vaults a day, however many sandboxes they open`, async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < VISITOR_DEPLOYS_PER_DAY; i++) {
      const who = sandbox(t, `visitor-a-${i}`);
      await readyToDeploy(t, who);
      await who.mutation(api.vault.confirmEnrol, { code: "123456" });
    }
    const extra = sandbox(t, "visitor-a-extra");
    await readyToDeploy(t, extra);
    await expect(extra.mutation(api.vault.confirmEnrol, { code: "123456" })).rejects.toThrow(/demo vaults today/);
    // Someone else is unaffected.
    const other = sandbox(t, "visitor-b", "cd".repeat(16));
    await readyToDeploy(t, other);
    await other.mutation(api.vault.confirmEnrol, { code: "123456" });
  });

  it("holds new sandbox vaults back when the relayer is nearly out of test ETH", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.ops.record, { address: "0x543D5327b9b80904d26e229777B0E8b37EE95170", balancesWei: ["1000"], perSandboxWei: "1000", runway: 1 });
    const who = sandbox(t, "late");
    await readyToDeploy(t, who);
    await expect(who.mutation(api.vault.confirmEnrol, { code: "123456" })).rejects.toThrow(/topped up/);
  });
});

describe("the judge account", () => {
  const judge = (t: ReturnType<typeof convexTest>, admin: boolean) =>
    t.withIdentity({ subject: "judge", issuer: ISSUER, tokenIdentifier: `${ISSUER}|judge`, judgeAdmin: admin });

  it("is read-only for visitors: no key rotation, no freezing, no settings", async () => {
    const t = convexTest(schema, modules);
    const visitor = judge(t, false);
    await visitor.mutation(api.users.ensure, {});
    expect((await visitor.query(api.users.me, {}))!.readOnly).toBe(true);
    const agents = await visitor.query(api.agents.list, {});
    const claude = agents.find((a: { provider: string }) => a.provider === "claude")!;
    await expect(visitor.mutation(api.gateway.issueToken, { agentId: claude._id })).rejects.toThrow(JUDGE_READ_ONLY);
    await expect(visitor.mutation(api.agents.setStatus, { agentId: claude._id, status: "frozen" })).rejects.toThrow(JUDGE_READ_ONLY);
    await expect(visitor.mutation(api.messages.send, { text: "pay someone" })).rejects.toThrow(JUDGE_READ_ONLY);
  });

  it("stays writable for the team's admin token", async () => {
    const t = convexTest(schema, modules);
    const admin = judge(t, true);
    await admin.mutation(api.users.ensure, {});
    expect((await admin.query(api.users.me, {}))!.readOnly).toBe(false);
    await admin.mutation(api.messages.send, { text: "hello" });
  });
});

describe("assistant quota", () => {
  it(`gives a sandbox ${ASSISTANT_TURNS.sandbox} model turns a day, then answers without the model`, async () => {
    const t = convexTest(schema, modules);
    const who = sandbox(t, "chatty");
    const userId = (await who.mutation(api.users.ensure, {}))!;
    for (let i = 0; i < ASSISTANT_TURNS.sandbox; i++) await who.mutation(api.messages.send, { text: `hi ${i}` });
    const counter = await t.run((ctx) => ctx.db.query("limits").withIndex("by_key", (q) => q.eq("key", `assistant:${userId}`)).unique());
    expect(counter!.count).toBe(ASSISTANT_TURNS.sandbox);
    await who.mutation(api.messages.send, { text: "one more" });
    const after = await t.run((ctx) => ctx.db.query("limits").withIndex("by_key", (q) => q.eq("key", `assistant:${userId}`)).unique());
    expect(after!.count).toBe(ASSISTANT_TURNS.sandbox);
  });
});
