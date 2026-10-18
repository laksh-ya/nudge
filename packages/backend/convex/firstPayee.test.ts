/// <reference types="vite/client" />
/**
 * The first-merchant payment on a live vault, end to end through the backend (#100): the path the
 * 18 Oct live coffee purchase took, and the issues it found (#89, #90, #92–#96, #98, #99).
 */
import { convexTest } from "convex-test";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAIN_ID, Op, actionDigest, base64url, checkApproval, toWebAuthnAuth, type ChainReader } from "@agent-wallet/domain";
import type { Address, Hex } from "viem";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

vi.mock("./lib/relayer", () => {
  const pool = { enqueueAction: vi.fn(async () => "queued") };
  return { relayer: pool, agentPool: pool, lanePool: () => pool, laneOf: () => 0, laneCount: () => 1, MAX_LANES: 4 };
});
const modules = import.meta.glob(["./**/*.ts", "./**/*.js", "!./**/*.test.ts"]);

const NOW = Date.UTC(2026, 9, 18, 8, 50);
const DAY = 86_400_000;
const RP = "nudge-approve.vercel.app";
const VAULT = "0x5169E18E11682316978BDdc430a781f62d586284" as Address;
const SHOP = "0x1592Aea1B8882f2CB138ed1f9B7FE7f88375Cfeb" as Address;
const TRUSTED = "0x00000000000000000000000000000000000000b2" as Address;
const KEY_ID = `0x${"11".repeat(32)}`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const priv = p256.utils.randomPrivateKey();
const point = p256.getPublicKey(priv, false);
const x = `0x${Buffer.from(point.slice(1, 33)).toString("hex")}`;
const y = `0x${Buffer.from(point.slice(33)).toString("hex")}`;

function assertion(challenge: Hex) {
  const authenticatorData = new Uint8Array([...sha256(new TextEncoder().encode(RP)), 0x05, 0, 0, 0, 1]);
  const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge: base64url(Buffer.from(challenge.slice(2), "hex")), origin: `https://${RP}` }));
  const msg = sha256(new Uint8Array([...authenticatorData, ...sha256(clientDataJSON)]));
  const a = toWebAuthnAuth({ authenticatorData, clientDataJSON, signature: p256.sign(msg, priv, { prehash: false }).toDERRawBytes() });
  return { ...a, challengeIndex: Number(a.challengeIndex), typeIndex: Number(a.typeIndex) };
}

/** The vault on a public node, which has no contact record for the shop. */
const emptyVault: ChainReader = {
  async contact() {
    return { payee: "0x0000000000000000000000000000000000000000", activeAt: 0n };
  },
};

async function liveOwner() {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity({ subject: "lakshya", issuer: "https://test.local", tokenIdentifier: "https://test.local|lakshya" });
  const userId = (await owner.mutation(api.users.ensure, {}))!;
  const ids = await t.run(async (ctx) => {
    await ctx.db.patch(userId, { name: "Lakshya", timezone: "Asia/Kolkata" });
    const agent = await ctx.db.insert("agents", {
      userId, name: "Claude", provider: "claude", status: "active", scopes: ["read", "prepare", "spend", "request"],
      dailyCapMinor: 2500, perPaymentMinor: 1500, spentTodayMinor: 0, hidesBalances: false, connectedAt: NOW, expiresAt: NOW + 30 * DAY,
      onchain: true, chainAddress: "0x00000000000000000000000000000000000000a1",
      vault: { perPaymentMinor: 1500, dailyCapMinor: 2500, expiresAt: NOW + 30 * DAY, active: true, frozen: false, strikes: 0, spentMinor: 0, syncedAt: NOW },
    });
    const trusted = await ctx.db.insert("payees", { userId, name: "Blue Tokai", handle: "shop", kind: "merchant", trusted: true, address: TRUSTED, onchain: true });
    await ctx.db.insert("wallets", {
      userId, address: VAULT, chain: "base-sepolia", asset: "USDC", balanceMinor: 25_000, protectedMinor: 5000, dailyCeilingMinor: 10_000, perPaymentMinor: 1500,
      frozen: false, status: "live", version: 3, keyX: x, keyY: y, rpId: RP, keyId: KEY_ID, credentialId: "cred-1",
      passkeys: [{ keyId: KEY_ID, x, y, credentialId: "cred-1", rpId: RP, label: "Phone", addedAt: NOW, status: "active" }],
      vault: { version: 3, protectedMinor: 5000, ceilingMinor: 10_000, contactDelay: 86_400, changeDelay: 120, holdAboveMinor: 500, holdFor: 120, frozen: false, balanceMinor: 25_000, heldMinor: 0, spentMinor: 0, headroomMinor: 10_000, ownerKeys: 1, syncedAt: NOW },
    });
    return { agent, trusted };
  });
  return { t, owner, userId, ...ids };
}

const tokenOf = (url: string) => url.split("/a/")[1]!;

describe("first payment to a new merchant on a live vault (#100)", () => {
  it("one link, one passkey, no dead end; the merchant is not trusted as a side effect", async () => {
    const f = await liveOwner();

    // The agent pays the shop's address: it needs the owner, with the reason named precisely.
    const first = await f.t.mutation(internal.gateway.proposePayment, { agentId: f.agent, toAddress: SHOP, name: "Nudge Test Shop", amount: 4, reason: "coffee" });
    expect(first.outcome).toBe("needs_approval");
    const d = first as { taskId: Id<"tasks">; approvalUrl: string; reason: string; message: string };
    expect(d.reason).toBe("Nudge Test Shop is a new payee, not a trusted contact");
    // The agent is told one passkey pays it once, and the vault's real wait (#89), not a made-up one.
    expect(d.message).toMatch(/one passkey pays it once/);
    expect(d.message).toMatch(/waits 2 min before the money leaves/);

    // Asking again (a retry) hands back the same link: no second link, no second notice (#95).
    const again = await f.t.mutation(internal.gateway.proposePayment, { agentId: f.agent, toAddress: SHOP, name: "Nudge Test Shop", amount: 4, reason: "coffee" });
    expect(again).toMatchObject({ outcome: "needs_approval", taskId: d.taskId, approvalUrl: d.approvalUrl });
    // A different invoice is a different payment, even for the same amount.
    const other = await f.t.mutation(internal.gateway.proposePayment, { agentId: f.agent, toAddress: SHOP, name: "Nudge Test Shop", amount: 4, reason: "second coffee", requestId: "inv-2" });
    expect((other as { taskId: Id<"tasks"> }).taskId).not.toBe(d.taskId);
    const open = await f.t.run((ctx) => ctx.db.query("tasks").withIndex("by_user_state", (q) => q.eq("userId", f.userId).eq("state", "awaiting_approval")).collect());
    expect(open).toHaveLength(2);

    // A copy of the same request made before this fix (an old duplicate link) is still open.
    const token = tokenOf(d.approvalUrl);
    const stale = await f.t.run(async (ctx) => {
      const task = (await ctx.db.get(d.taskId))!;
      const { _id, _creationTime, ...rest } = task;
      return await ctx.db.insert("tasks", { ...rest, approvalToken: "staleduplicatelink000001", requestId: undefined });
    });

    // The approval page: the shop is a new payee, which is not a disagreement, so signing is possible (#90, #91).
    const page = (await f.t.query(api.approvals.get, { token }))!;
    expect(page.onchain!.contacts).toEqual([expect.objectContaining({ address: SHOP, saved: false })]);
    const a = page.onchain!.action;
    const truth = await checkApproval(
      a.op as Op,
      a.data as Hex,
      { amountMinor: page.amountMinor, payee: page.payee, contacts: page.onchain!.contacts, names: page.onchain!.names },
      emptyVault,
    );
    expect(truth.mismatches).toEqual([]);
    expect(truth.payee).toMatchObject({ fresh: true, saved: null, address: SHOP });
    expect(truth.lines[0]).toMatchObject({ tone: "bad" }); // still red: the owner checks the address
    expect(page.reason).toBe("Nudge Test Shop is a new payee, not a trusted contact");

    // One passkey signature pays it. Every other link for the same payment closes (#95, #96).
    const digest = actionDigest({ op: a.op as Op, data: a.data as Hex, nonce: BigInt(a.nonce), deadline: BigInt(a.deadline) }, VAULT, CHAIN_ID);
    expect(await f.t.mutation(api.approvals.submit, { token, auth: assertion(digest), credentialId: "cred-1" })).toBe("reserved");
    const after = await f.t.run(async (ctx) => ({ mine: await ctx.db.get(d.taskId), stale: await ctx.db.get(stale) }));
    expect(after.mine!.state).toBe("reserved");
    expect(after.stale).toMatchObject({ state: "cancelled", reason: "Handled through another link for the same request" });
    const stalePage = await f.t.query(api.approvals.get, { token: "staleduplicatelink000001" });
    expect(stalePage).toMatchObject({ state: "cancelled", reason: "Handled through another link for the same request" });

    // The vault queues it for its change delay. The reason names that wait, not the contact wait (#93),
    // and status says it isn't final yet and when it pays (#94).
    await f.t.mutation(internal.vault.onQueued, { taskId: d.taskId, txHash: `0x${"cd".repeat(32)}`, changeId: `0x${"ef".repeat(32)}`, readyAt: NOW + 120_000 });
    const queued = await f.t.query(internal.gateway.taskStatus, { agentId: f.agent, taskId: d.taskId });
    expect(queued).toMatchObject({ state: "queued", final: false, readyAt: new Date(NOW + 120_000).toISOString() });
    expect(queued.next).toMatch(/pays at .* unless the owner cancels/);
    expect(queued.reason).toMatch(/^Approved\. Paying someone not saved in your vault waits 2 min \(your vault's change delay\)/);
    expect(queued.reason).not.toMatch(/Loosening/);

    await f.t.mutation(internal.vault.onOwnerResult, { taskId: d.taskId, txHash: `0x${"ab".repeat(32)}`, ok: true });
    const done = await f.t.query(internal.gateway.taskStatus, { agentId: f.agent, taskId: d.taskId });
    expect(done).toMatchObject({ state: "confirmed", final: true });

    // Paying once did not make the shop trusted (#98): the agent still needs the owner next time,
    // and list_contacts says so plainly (#92).
    const contacts = await f.t.query(internal.gateway.contacts, { agentId: f.agent });
    expect(contacts.find((c) => c.name === "Nudge Test Shop")).toMatchObject({ status: "new", trusted: false });
  });

  it("a saved contact still in the vault's wait says until when, in the owner's time (#89, #92)", async () => {
    const f = await liveOwner();
    const payee = await f.t.run((ctx) =>
      ctx.db.insert("payees", { userId: f.userId, name: "Ravi", handle: "0x…", kind: "person", trusted: true, address: SHOP, onchain: true, activeAt: NOW + DAY }),
    );
    const r = await f.t.mutation(internal.gateway.proposePayment, { agentId: f.agent, contactId: payee, amount: 3, reason: "lunch" });
    expect(r.outcome).toBe("needs_approval");
    expect((r as { reason: string }).reason).toMatch(/^Ravi is saved, but agents may pay it on their own only from .*19 Oct.* \(your vault's 1 day wait for new contacts\)$/);
    const contacts = await f.t.query(internal.gateway.contacts, { agentId: f.agent });
    expect(contacts.find((c) => c.name === "Ravi")).toMatchObject({ status: "waiting", trusted: false, activeAt: new Date(NOW + DAY).toISOString() });
  });

  it("under the limits, to a trusted contact, the agent pays straight away with no passkey (#99)", async () => {
    const f = await liveOwner();
    const r = await f.t.mutation(internal.gateway.proposePayment, { agentId: f.agent, contactId: f.trusted, amount: 4, reason: "coffee" });
    expect(r.outcome).toBe("submitted");
    const task = await f.t.run((ctx) => ctx.db.get((r as { taskId: Id<"tasks"> }).taskId));
    expect(task).toMatchObject({ state: "reserved", rail: "base-sepolia" });
    expect(task!.approvalToken).toBeUndefined();
    // Over the per-payment limit, the same contact needs the passkey.
    expect((await f.t.mutation(internal.gateway.proposePayment, { agentId: f.agent, contactId: f.trusted, amount: 20, reason: "big order" })).outcome).toBe("needs_approval");
  });
});

describe("contact trust comes from the vault's own records (#101)", () => {
  const VAULT_STATE = { version: 3, protectedMinor: 5000, ceilingMinor: 10_000, contactDelay: 86_400, changeDelay: 120, holdAboveMinor: 500, holdFor: 120, frozen: false, balanceMinor: 25_000, heldMinor: 0, spentMinor: 0, headroomMinor: 10_000, ownerKeys: 1, syncedAt: NOW };

  it("a contact the vault made active early (an immediate re-add) is trusted, whatever we estimated", async () => {
    const f = await liveOwner();
    // Our estimate after the first add: payable only tomorrow. The vault's record says since yesterday.
    const harsh = await f.t.run((ctx) =>
      ctx.db.insert("payees", { userId: f.userId, name: "harsh", handle: "0x…", kind: "person", trusted: true, address: SHOP, onchain: true, activeAt: NOW + DAY }),
    );
    const walletId = await f.t.run(async (ctx) => (await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", f.userId)).unique())!._id);
    expect((await f.t.query(internal.gateway.contacts, { agentId: f.agent })).find((c) => c.name === "harsh")).toMatchObject({ status: "waiting" });

    await f.t.mutation(internal.vault.onVaultState, { walletId, vault: VAULT_STATE, agents: [], contacts: [{ payeeId: harsh, payee: SHOP.toLowerCase(), activeAt: Math.floor((NOW - 18 * 3_600_000) / 1000) }] });
    expect((await f.t.query(internal.gateway.contacts, { agentId: f.agent })).find((c) => c.name === "harsh")).toMatchObject({ status: "trusted", trusted: true });
    // And the agent pays within its limits with no approval link.
    expect((await f.t.mutation(internal.gateway.proposePayment, { agentId: f.agent, contactId: harsh, amount: 3, reason: "lunch" })).outcome).toBe("submitted");
  });

  it("no record in the vault, or one for another address, means agents can't pay it alone", async () => {
    const f = await liveOwner();
    const walletId = await f.t.run(async (ctx) => (await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", f.userId)).unique())!._id);
    await f.t.mutation(internal.vault.onVaultState, { walletId, vault: VAULT_STATE, agents: [], contacts: [{ payeeId: f.trusted, payee: "0x0000000000000000000000000000000000000000", activeAt: 0 }] });
    expect((await f.t.query(internal.gateway.contacts, { agentId: f.agent })).find((c) => c.name === "Blue Tokai")).toMatchObject({ status: "new", trusted: false });
    expect((await f.t.mutation(internal.gateway.proposePayment, { agentId: f.agent, contactId: f.trusted, amount: 3, reason: "coffee" })).outcome).toBe("needs_approval");
  });
});

describe("the AP2 mandate follows the vault's contact rule (#102)", () => {
  it("lists only contacts past their waiting period, and dates the list", async () => {
    const f = await liveOwner();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("payees", { userId: f.userId, name: "Nudge demo store", handle: "0x…", kind: "merchant", trusted: true, address: SHOP, onchain: true, activeAt: NOW + DAY });
      await ctx.db.insert("tasks", {
        userId: f.userId, title: "Let Claude pay within limits", channel: "app", state: "confirmed", rail: "base-sepolia", updatedAt: NOW,
        txHash: `0x${"aa".repeat(32)}`, effects: { agents: [f.agent], payees: [] },
      });
    });
    const m = (await f.t.query(internal.gateway.mandate, { agentId: f.agent })) as unknown as { "x-policyvault": { contacts: { name: string }[]; contacts_as_of?: string } } & Record<string, { natural_language_description: string }>;
    const names = m["x-policyvault"].contacts.map((c) => c.name);
    expect(names).toEqual(["Blue Tokai"]);
    expect(m["x-policyvault"].contacts_as_of).toBe(new Date(Math.floor(NOW / 1000) * 1000).toISOString());
    const text = Object.values(m).find((v) => v && typeof v === "object" && "natural_language_description" in v)!.natural_language_description;
    expect(text).toMatch(/may pay the contacts saved in my vault \(as of 2026-10-18 08:50 UTC: Blue Tokai\)/);
  });
});

describe("payments the owner approved for an agent count toward its limits (#105)", () => {
  it("an approved $20 leaves $5 of a $25 day, and the per-contact total sees it too", async () => {
    const f = await liveOwner();
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.trusted, { dailyCapMinor: 2500 });
      // Claude asked for $20 (over its $15 per payment); the owner approved it with the passkey.
      await ctx.db.insert("tasks", {
        userId: f.userId, title: "Pay Blue Tokai", channel: "mcp", agentId: f.agent, payeeId: f.trusted, amountMinor: 2000, currency: "USDC",
        state: "confirmed", rail: "base-sepolia", approvedByOwner: true, updatedAt: NOW,
        action: { op: Op.Pay, data: "0x", nonce: "1", deadline: Math.floor(NOW / 1000) + 600 },
      });
    });
    const limits = await f.t.query(internal.gateway.myLimits, { agentId: f.agent });
    expect(limits.leftToday.amountMinor).toBe(500);
    // $6 on its own would exceed what's left of its day, and of Blue Tokai's $25 for all agents.
    const r = await f.t.mutation(internal.gateway.proposePayment, { agentId: f.agent, contactId: f.trusted, amount: 6, reason: "more coffee" });
    expect(r.outcome).toBe("needs_approval");
    expect((r as { reason: string }).reason).toMatch(/daily limit/);
    expect((r as { reason: string }).reason).toMatch(/Blue Tokai's \$25\.00 daily limit for all agents/);
    // $4 still fits, and goes straight through.
    expect((await f.t.mutation(internal.gateway.proposePayment, { agentId: f.agent, contactId: f.trusted, amount: 4, reason: "coffee" })).outcome).toBe("submitted");
  });
});

describe("approval links always point at the real approval site (#110)", () => {
  it("ignores a retired, non-https or broken APPROVE_URL", async () => {
    const { approveBase } = await import("./lib/links");
    vi.stubEnv("APPROVE_URL", "");
    expect(approveBase()).toBe("https://nudge-approve.vercel.app");
    vi.stubEnv("APPROVE_URL", "https://agent-wallet-approve.vercel.app");
    expect(approveBase()).toBe("https://nudge-approve.vercel.app");
    vi.stubEnv("APPROVE_URL", "http://evil.example");
    expect(approveBase()).toBe("https://nudge-approve.vercel.app");
    vi.stubEnv("APPROVE_URL", "not a url");
    expect(approveBase()).toBe("https://nudge-approve.vercel.app");
    vi.stubEnv("APPROVE_URL", "https://approve.staging.example/");
    expect(approveBase()).toBe("https://approve.staging.example");
    vi.unstubAllEnvs();
  });
});

describe("onboarding wallet step after the passkey (#122)", () => {
  it("Save and continue with the vault's own numbers asks for no passkey; a real change asks once", async () => {
    const f = await liveOwner();
    // The vault holds $100/day and $50 protected; the form shows those.
    const same = await f.owner.mutation(api.onboarding.setupWallet, { dailyCeilingMinor: 10_000, protectedMinor: 5000, perPaymentMinor: 1000 });
    expect(same).toBeNull();
    // Raising the ceiling is a vault change: one link, and asking again returns the same link.
    const first = await f.owner.mutation(api.onboarding.setupWallet, { dailyCeilingMinor: 12_000, protectedMinor: 5000, perPaymentMinor: 1000 });
    const again = await f.owner.mutation(api.onboarding.setupWallet, { dailyCeilingMinor: 12_000, protectedMinor: 5000, perPaymentMinor: 1000 });
    expect(first).toBeTruthy();
    expect(again).toBe(first);
  });
});

describe("reminders warn when the paying account is short (#118)", () => {
  it("flags a debit account or card holding less than the bill, never a credit card's debt", async () => {
    const { shortfall } = await import("./reminders");
    const bill = { amountMinor: 64_900, currency: "INR" } as never;
    const acct = (kind: string, balanceMinor: number, currency = "INR") => ({ kind, balanceMinor, currency, name: "HDFC Debit" }) as never;
    expect(shortfall(bill, acct("bank", 40_000), {})).toMatchObject({ short: 24_900, has: 40_000 });
    expect(shortfall(bill, acct("bank", 90_000), {})).toBeNull();
    expect(shortfall(bill, acct("card", -120_000), {})).toBeNull();
    expect(shortfall(bill, acct("card", 10_000), {})).toMatchObject({ short: 54_900 });
    expect(shortfall(bill, null, {})).toBeNull();
  });
});
