/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * Issue #27. The gateway's payment decision over every combination of scope, amount, frozen wallet,
 * new contact and simulated vs live vault, checked against an oracle written from the rules (not
 * from the code); then Telegram inbound and the MCP rate limit.
 */
const sent: unknown[] = [];
vi.mock("./lib/relayer", () => {
  const pool = { enqueueAction: vi.fn(async (_c: unknown, _f: unknown, args: unknown) => (sent.push(args), "queued")) };
  return { relayer: pool, agentPool: pool, lanePool: () => pool, laneOf: () => 0, laneCount: () => 1, MAX_LANES: 4 };
});
const modules = import.meta.glob(["./**/*.ts", "./**/*.js", "!./**/*.test.ts"]);

const NOW = Date.UTC(2026, 9, 16, 6);
const DAY = 86_400_000;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  sent.length = 0;
});
afterEach(() => vi.useRealTimers());

type Scopes = "full" | "noSpend" | "noRequest" | "readOnly";
const SCOPES: Record<Scopes, ("read" | "prepare" | "spend" | "request")[]> = {
  full: ["read", "prepare", "spend", "request"],
  noSpend: ["read", "prepare", "request"],
  noRequest: ["read", "prepare", "spend"],
  readOnly: ["read"],
};
type Amount = "within" | "overPerPayment" | "overDaily";
type Case = { scopes: Scopes; amount: Amount; walletFrozen: boolean; newContact: boolean; live: boolean };

/** What the rules say should happen, independent of gateway.ts. Limits: $15 a payment, $25 a day. */
function oracle(c: Case): { throws: true } | { outcome: string; code?: string } {
  if (c.scopes === "readOnly") return { throws: true }; // no "prepare": can't even propose
  const reasons: string[] = [];
  if (c.walletFrozen) reasons.push("1002");
  if (!SCOPES[c.scopes].includes("spend")) reasons.push("2002");
  if (c.amount !== "within") reasons.push("2003");
  if (c.newContact) reasons.push("2006");
  if (reasons.length === 0) return { outcome: "submitted" };
  // A frozen wallet is a hard stop; an assistant that may spend but not ask the owner is refused.
  if (c.walletFrozen) return { outcome: "refused", code: "1002" };
  if (!SCOPES[c.scopes].includes("request") && SCOPES[c.scopes].includes("spend")) return { outcome: "refused", code: reasons[0] };
  return { outcome: "needs_approval" };
}

async function world(c: Case) {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity({ subject: "alice", issuer: "https://test.local", tokenIdentifier: "https://test.local|alice" });
  const alice = (await owner.mutation(api.users.ensure, {}))!;
  const ids = await t.run(async (ctx) => {
    const agent = await ctx.db.insert("agents", {
      userId: alice, name: "Claude", provider: "claude", status: "active", scopes: SCOPES[c.scopes],
      dailyCapMinor: 2500, perPaymentMinor: 1500, spentTodayMinor: c.amount === "overDaily" ? 2400 : 0, hidesBalances: false, connectedAt: NOW, expiresAt: NOW + 30 * DAY,
      ...(c.live ? { onchain: true, chainAddress: "0x00000000000000000000000000000000000000a1", vault: { perPaymentMinor: 1500, dailyCapMinor: 2500, expiresAt: NOW + 30 * DAY, active: true, frozen: false, strikes: 0, spentMinor: 0, syncedAt: NOW } } : {}),
    });
    const payee = await ctx.db.insert("payees", {
      userId: alice, name: "Blue Tokai", handle: "shop", kind: "merchant", trusted: !c.newContact, address: "0x00000000000000000000000000000000000000b2", onchain: true,
      ...(c.newContact ? { holdUntil: NOW + DAY } : {}),
    });
    await ctx.db.insert("wallets", {
      userId: alice, address: c.live ? "0x5169E18E11682316978BDdc430a781f62d586284" : "", chain: "base-sepolia", asset: "USDC", balanceMinor: 25_000,
      protectedMinor: 5000, dailyCeilingMinor: 10_000, perPaymentMinor: 1500, frozen: c.walletFrozen,
      ...(c.live
        ? {
            status: "live" as const, version: 3,
            vault: { version: 3, protectedMinor: 5000, ceilingMinor: 10_000, contactDelay: 86400, changeDelay: 120, holdAboveMinor: 500, holdFor: 120, frozen: false, balanceMinor: 25_000, heldMinor: 0, spentMinor: 0, headroomMinor: 10_000, ownerKeys: 1, syncedAt: NOW },
          }
        : {}),
    });
    return { agent, payee };
  });
  return { t, alice, ...ids };
}

const AMOUNT: Record<Amount, number> = { within: 3, overPerPayment: 20, overDaily: 3 };
const cases: Case[] = [];
for (const scopes of Object.keys(SCOPES) as Scopes[])
  for (const amount of Object.keys(AMOUNT) as Amount[])
    for (const walletFrozen of [false, true])
      for (const newContact of [false, true]) for (const live of [false, true]) cases.push({ scopes, amount, walletFrozen, newContact, live });

describe("gateway decision matrix (scope x limits x frozen x new contact x live/simulated)", () => {
  it.each(cases.map((c) => [`${c.scopes} ${c.amount}${c.walletFrozen ? " frozen" : ""}${c.newContact ? " new-contact" : ""} ${c.live ? "live" : "sim"}`, c] as const))("%s", async (_name, c) => {
    const w = await world(c);
    const want = oracle(c);
    const run = () => w.t.mutation(internal.gateway.proposePayment, { agentId: w.agent, contactId: w.payee, amount: AMOUNT[c.amount], reason: "matrix" });
    if ("throws" in want) {
      await expect(run()).rejects.toThrow(/can only read .* "Prepare payments"/);
      return;
    }
    const got = await run();
    expect(got.outcome).toBe(want.outcome);
    if (want.code) expect("code" in got ? got.code : undefined).toBe(want.code);
    // Money only moves for "submitted": on a live vault the agent's own key is queued to pay.
    expect(sent.length > 0).toBe(got.outcome === "submitted" && c.live);
    if (got.outcome === "needs_approval") {
      const task = await w.t.run((ctx) => ctx.db.get(got.taskId as Id<"tasks">));
      expect(task!.state).toBe("awaiting_approval");
    }
  });

  it("a frozen, disconnected or expired assistant is stopped before any check", async () => {
    for (const patch of [{ status: "frozen" as const }, { status: "revoked" as const }, { expiresAt: NOW - 1 }]) {
      const w = await world({ scopes: "full", amount: "within", walletFrozen: false, newContact: false, live: false });
      await w.t.run((ctx) => ctx.db.patch(w.agent, patch));
      await expect(w.t.mutation(internal.gateway.proposePayment, { agentId: w.agent, contactId: w.payee, amount: 3, reason: "x" })).rejects.toThrow();
    }
  });

  it("an unknown or another owner's contact is refused with 2010", async () => {
    const w = await world({ scopes: "full", amount: "within", walletFrozen: false, newContact: false, live: true });
    const bob = (await w.t.withIdentity({ subject: "bob", issuer: "https://test.local", tokenIdentifier: "https://test.local|bob" }).mutation(api.users.ensure, {}))!;
    const other = await w.t.run((ctx) => ctx.db.insert("payees", { userId: bob, name: "Bob's shop", handle: "b", kind: "merchant", trusted: true }));
    for (const contactId of [other, "not-an-id"]) {
      const got = await w.t.mutation(internal.gateway.proposePayment, { agentId: w.agent, contactId, amount: 3, reason: "x" });
      expect(got).toMatchObject({ outcome: "refused", code: "2010" });
    }
    expect(sent).toHaveLength(0);
  });
});

describe("MCP rate limit", () => {
  it("allows 60 calls a minute per assistant, then refuses, then allows again next minute", async () => {
    const w = await world({ scopes: "full", amount: "within", walletFrozen: false, newContact: false, live: false });
    for (let i = 0; i < 60; i++) expect(await w.t.mutation(internal.gateway.allow, { agentId: w.agent })).toBe(true);
    expect(await w.t.mutation(internal.gateway.allow, { agentId: w.agent })).toBe(false);
    vi.setSystemTime(NOW + 61_000);
    expect(await w.t.mutation(internal.gateway.allow, { agentId: w.agent })).toBe(true);
  });

  it("counts every call in a batch", async () => {
    const w = await world({ scopes: "full", amount: "within", walletFrozen: false, newContact: false, live: false });
    expect(await w.t.mutation(internal.gateway.allow, { agentId: w.agent, calls: 59 })).toBe(true);
    expect(await w.t.mutation(internal.gateway.allow, { agentId: w.agent, calls: 2 })).toBe(false);
  });
});

describe("Telegram inbound", () => {
  const SECRET = "test-secret";
  beforeEach(() => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  async function linked(code = "ABC123", linkedChat?: string) {
    const w = await world({ scopes: "full", amount: "within", walletFrozen: false, newContact: false, live: false });
    const link = await w.t.run((ctx) =>
      ctx.db.insert("chatLinks", { userId: w.alice, channel: "telegram", code, codeExpiresAt: NOW + 10 * 60_000, ...(linkedChat ? { externalId: linkedChat, linkedAt: NOW - DAY } : {}) }),
    );
    return { ...w, link };
  }
  type T = Awaited<ReturnType<typeof world>>["t"];
  const post = (t: T, body: object, secret = SECRET) =>
    t.fetch("/telegram", { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(body) });
  const msg = (update_id: number, text: string, extra: object = {}) => ({ update_id, message: { text, chat: { id: 42, type: "private" }, from: { username: "asha" }, ...extra } });
  const messages = (w: { t: T; alice: Id<"users"> }) => w.t.run((ctx) => ctx.db.query("messages").withIndex("by_user", (q) => q.eq("userId", w.alice)).collect());

  it("refuses a request without the webhook secret", async () => {
    const w = await linked();
    expect((await post(w.t, msg(1, "hi"), "wrong")).status).toBe(403);
  });

  it("links with a fresh one-use code, and the code can't be used twice", async () => {
    const w = await linked();
    await post(w.t, msg(1, "/start ABC123"));
    const after = await w.t.run((ctx) => ctx.db.get(w.link));
    expect(after!.externalId).toBe("42");
    expect(after!.linkedAt).toBeTruthy();
    expect(after!.code).not.toBe("ABC123");
  });

  it("refuses an expired code", async () => {
    const w = await linked();
    vi.setSystemTime(NOW + 11 * 60_000);
    await post(w.t, msg(1, "/start ABC123"));
    expect((await w.t.run((ctx) => ctx.db.get(w.link)))!.linkedAt).toBeUndefined();
  });

  it("moving a linked account to another chat needs the owner's yes", async () => {
    const w = await linked("ABC123", "7");
    await post(w.t, msg(1, "/start ABC123"));
    const after = (await w.t.run((ctx) => ctx.db.get(w.link)))!;
    expect(after.externalId).toBe("7");
    expect(after.pendingExternalId).toBe("42");
  });

  it("ignores an unlinked chat, a group, a bot, and a forwarded message", async () => {
    const w = await linked();
    await post(w.t, msg(1, "pay Blue Tokai $4")); // not linked yet
    await post(w.t, { update_id: 2, message: { text: "pay Blue Tokai $4", chat: { id: -100, type: "group" }, from: { username: "x" } } });
    await post(w.t, msg(3, "pay Blue Tokai $4", { from: { is_bot: true } }));
    await post(w.t, msg(4, "pay Blue Tokai $4", { forward_origin: { type: "user" } }));
    expect((await messages(w)).filter((m) => m.role === "user")).toHaveLength(0);
  });

  it("handles a redelivered update once", async () => {
    const w = await linked("ABC123", "42");
    await post(w.t, msg(9, "what can I spend?"));
    await post(w.t, msg(9, "what can I spend?"));
    expect((await messages(w)).filter((m) => m.role === "user")).toHaveLength(1);
  });
});
