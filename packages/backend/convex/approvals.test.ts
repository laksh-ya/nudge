/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAIN_ID, Op, actionDigest, base64url, encode, toTokenUnits, toWebAuthnAuth } from "@agent-wallet/domain";
import type { Address, Hex } from "viem";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const taskOf = (r: unknown) => (r as { taskId: Id<"tasks"> }).taskId;

// Only the transaction queue is stubbed; every handler and the schema run unchanged.
vi.mock("./lib/relayer", () => {
  const pool = { enqueueAction: vi.fn(async () => "queued") };
  return { relayer: pool, agentPool: pool, lanePool: () => pool, laneOf: () => 0, laneCount: () => 1, MAX_LANES: 4 };
});
const modules = import.meta.glob(["./**/*.ts", "./**/*.js", "!./**/*.test.ts"]);

const NOW = Date.UTC(2026, 9, 16, 6);
const DAY = 86_400_000;
const RP = "agent-wallet-approve.vercel.app";
const VAULT = "0x5169E18E11682316978BDdc430a781f62d586284" as Address;
const SHOP = "0xCb4C82Dc556883c90eBd9a7440b096728a7A5fc6" as Address;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const priv = p256.utils.randomPrivateKey();
const point = p256.getPublicKey(priv, false);
const x = `0x${Buffer.from(point.slice(1, 33)).toString("hex")}`;
const y = `0x${Buffer.from(point.slice(33)).toString("hex")}`;

async function fixture() {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity({ subject: "alice", issuer: "https://test.local", tokenIdentifier: "https://test.local|alice" });
  const stranger = t.withIdentity({ subject: "eve", issuer: "https://test.local", tokenIdentifier: "https://test.local|eve" });
  const alice = (await owner.mutation(api.users.ensure, {}))!;
  await stranger.mutation(api.users.ensure, {});
  const ids = await t.run(async (ctx) => {
    const agent = await ctx.db.insert("agents", {
      userId: alice, name: "Claude", provider: "claude", status: "active", scopes: ["read", "prepare", "spend", "request"],
      dailyCapMinor: 1500, perPaymentMinor: 1000, spentTodayMinor: 0, hidesBalances: true, connectedAt: NOW, expiresAt: NOW + 30 * DAY,
    });
    const payee = await ctx.db.insert("payees", { userId: alice, name: "Blue Tokai", handle: "shop", kind: "merchant", trusted: true, address: SHOP, onchain: true });
    await ctx.db.insert("wallets", {
      userId: alice, address: "", chain: "base-sepolia", asset: "USDC", balanceMinor: 25_000, protectedMinor: 5000,
      dailyCeilingMinor: 4000, perPaymentMinor: 1500, frozen: false,
    });
    return { agent, payee };
  });
  return { t, owner, stranger, alice, ...ids };
}

/** A live vault with one passkey, and an awaiting owner payment of $12 to the shop. */
async function liveApproval(f: Awaited<ReturnType<typeof fixture>>) {
  const action = { op: Op.Pay, data: encode.pay(SHOP, toTokenUnits(1200), `0x${"ab".repeat(32)}`), nonce: 77n, deadline: BigInt(Math.floor(NOW / 1000) + 1800) };
  const token = "abcdefghijklmnopqrstuvwx";
  await f.t.run(async (ctx) => {
    const w = (await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", f.alice)).unique())!;
    await ctx.db.patch(w._id, {
      status: "live", version: 2, address: VAULT, keyX: x, keyY: y, rpId: RP, keyId: `0x${"11".repeat(32)}`, credentialId: "cred-1",
      passkeys: [{ keyId: `0x${"11".repeat(32)}`, x, y, credentialId: "cred-1", rpId: RP, label: "Phone", addedAt: NOW, status: "active" }],
    });
    await ctx.db.insert("tasks", {
      userId: f.alice, title: "Pay Blue Tokai", channel: "mcp", agentId: f.agent, payeeId: f.payee, amountMinor: 1200, currency: "USDC",
      state: "awaiting_approval", rail: "base-sepolia", approvalToken: token, expiresAt: NOW + 1800_000, updatedAt: NOW,
      action: { op: action.op, data: action.data, nonce: action.nonce.toString(), deadline: Number(action.deadline) },
    });
  });
  return { token, digest: actionDigest(action, VAULT, CHAIN_ID) };
}

function assertion(challenge: Hex, opts: { key?: Uint8Array } = {}) {
  const authenticatorData = new Uint8Array([...sha256(new TextEncoder().encode(RP)), 0x05, 0, 0, 0, 1]);
  const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge: base64url(Buffer.from(challenge.slice(2), "hex")), origin: `https://${RP}` }));
  const msg = sha256(new Uint8Array([...authenticatorData, ...sha256(clientDataJSON)]));
  const a = toWebAuthnAuth({ authenticatorData, clientDataJSON, signature: p256.sign(msg, opts.key ?? priv, { prehash: false }).toDERRawBytes() });
  return { ...a, challengeIndex: Number(a.challengeIndex), typeIndex: Number(a.typeIndex) };
}

const taskState = (f: Awaited<ReturnType<typeof fixture>>, token: string) =>
  f.t.run(async (ctx) => (await ctx.db.query("tasks").withIndex("by_approval_token", (q) => q.eq("approvalToken", token)).unique())!.state);

describe("approval links in an agent's hands can't approve anything (#6, revised 18 Oct)", () => {
  // The agent now hands the owner the link (no trip to the website), so the link must be harmless
  // to the agent: approving needs the signed-in owner or their passkey (next tests).
  it("an over-limit request returns the approval link for the owner", async () => {
    const f = await fixture();
    const r = await f.t.mutation(internal.gateway.proposePayment, { agentId: f.agent, contactId: f.payee, amount: 12, reason: "over the limit" });
    expect(r.outcome).toBe("needs_approval");
    const task = await f.t.run((ctx) => ctx.db.get(taskOf(r)));
    expect(r).toMatchObject({ approvalUrl: `https://nudge-approve.vercel.app/a/${task!.approvalToken}` });
  });

  it("a token holder who isn't the signed-in owner can neither approve nor decline", async () => {
    const f = await fixture();
    const r = await f.t.mutation(internal.gateway.proposePayment, { agentId: f.agent, contactId: f.payee, amount: 12, reason: "over the limit" });
    const token = (await f.t.run((ctx) => ctx.db.get(taskOf(r))))!.approvalToken!;
    await expect(f.t.mutation(api.approvals.decide, { token, approve: true })).rejects.toThrow("Not signed in");
    await expect(f.t.mutation(api.approvals.decide, { token, approve: false })).rejects.toThrow("Not signed in");
    await expect(f.stranger.mutation(api.approvals.decide, { token, approve: true })).rejects.toThrow("no longer valid");
    expect(await taskState(f, token)).toBe("awaiting_approval");
    expect(await f.owner.mutation(api.approvals.decide, { token, approve: true })).toBe("submitted");
  });

  it("a junk signature leaves the request open, and attempts are capped", async () => {
    const f = await fixture();
    const { token, digest } = await liveApproval(f);
    const junk = { r: "0x00", s: "0x00", challengeIndex: 0, typeIndex: 0, authenticatorData: "0x", clientDataJSON: "garbage" };
    expect(await f.t.mutation(api.approvals.submit, { token, auth: junk })).toBe("rejected");
    expect(await taskState(f, token)).toBe("awaiting_approval");
    // A real signature over a different request, or by another key, is junk too.
    expect(await f.t.mutation(api.approvals.submit, { token, auth: assertion(`0x${"22".repeat(32)}`) })).toBe("rejected");
    expect(await f.t.mutation(api.approvals.submit, { token, auth: assertion(digest, { key: p256.utils.randomPrivateKey() }) })).toBe("rejected");
    for (let i = 0; i < 7; i++) await f.t.mutation(api.approvals.submit, { token, auth: junk });
    expect(await f.t.mutation(api.approvals.submit, { token, auth: junk })).toBe("too_many_attempts");
    expect(await taskState(f, token)).toBe("awaiting_approval");
  });

  it("the owner's real passkey signature is accepted and queued", async () => {
    const f = await fixture();
    const { token, digest } = await liveApproval(f);
    expect(await f.t.mutation(api.approvals.submit, { token, credentialId: "cred-1", auth: assertion(digest) })).toBe("reserved");
    expect(await taskState(f, token)).toBe("reserved");
  });

  it("the approval page data holds only this action: no balance, no owner, no other contacts", async () => {
    const f = await fixture();
    await f.t.run((ctx) => ctx.db.insert("payees", { userId: f.alice, name: "Someone else", handle: "x", kind: "person", trusted: true, address: "0x1111111111111111111111111111111111111111" }));
    const { token } = await liveApproval(f);
    const page = await f.t.query(api.approvals.get, { token });
    const text = JSON.stringify(page);
    expect(text).not.toContain("25000");
    expect(page).not.toHaveProperty("owner");
    expect(page).not.toHaveProperty("wallet");
    expect(text).not.toContain("Someone else");
    expect(page!.onchain!.contacts).toEqual([{ payeeId: f.payee, name: "Blue Tokai", address: SHOP }]);
  });
});
