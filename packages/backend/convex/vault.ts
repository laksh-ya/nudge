import { v } from "convex/values";
import { base64url, EXPLORER, formatMoney, isVaultVersion, keyIdOf, Op, REFUSAL, testPayeeAddress, VAULT_VERSION } from "@agent-wallet/domain";
import type { Hex } from "viem";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { isSandbox, requireViewer, viewer } from "./lib/auth";
import { newApprovalToken } from "./lib/seed";
import { addKeyTask, contactCapTask, setupTask } from "./lib/actions";
import { relayer } from "./lib/relayer";
import { hit } from "./lib/limits";
import { spendDeploy } from "./lib/budget";
import { chainReady } from "./chain";

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const ENROL_MINUTES = 15;

function allowedRpIds() {
  return (process.env.RP_IDS ?? "agent-wallet-approve.vercel.app,localhost").split(",").map((s) => s.trim());
}

async function walletOf(ctx: MutationCtx, userId: Id<"users">) {
  return await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
}

export const status = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return null;
    const w = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    if (!w) return { wallet: null, setup: null, waiting: [], ready: chainReady() };
    const tasks = await ctx.db.query("tasks").withIndex("by_user_updated", (q) => q.eq("userId", user._id)).order("desc").take(100);
    const setup = tasks.find(
      (t) => t.state === "awaiting_approval" && t.action && (t.action.op === Op.Batch || t.action.op === Op.SetAgent || t.action.op === Op.AddContact),
    );
    const waiting = tasks
      .filter((t) => t.state === "queued" || t.state === "held" || (t.state === "unknown" && t.rail === "base-sepolia"))
      .map((t) => ({ _id: t._id, title: t.title, state: t.state, amountMinor: t.amountMinor, readyAt: t.readyAt, releaseAt: t.releaseAt, txHash: t.txHash, reason: t.reason }));
    return {
      ready: chainReady(),
      wallet: {
        status: w.status ?? null,
        statusNote: w.statusNote,
        address: w.address || null,
        deployTx: w.deployTx,
        rpId: w.rpId,
        hasPasskey: Boolean(w.keyId),
        version: w.version ?? (w.address ? 1 : null),
        vault: w.vault ?? null,
        passkeys: (w.passkeys ?? []).filter((p) => p.status !== "removed").map((p) => ({ keyId: p.keyId, label: p.label, addedAt: p.addedAt, status: p.status })),
        // The confirmation code stays on the phone that made the passkey; the app never sees it.
        candidate: w.candidate ? { at: w.candidate.at, device: w.candidate.device, purpose: w.candidate.purpose } : null,
        previous: w.previous ?? [],
        explorer: EXPLORER,
      },
      setup: setup ? { title: setup.title, token: setup.approvalToken } : null,
      waiting,
    };
  },
});

// ------------------------------------------------------------ enrolment

/**
 * Step one of passkey enrolment: a one-time link to the approval site. A passkey made from it
 * does nothing until the signed-in owner types the code that site shows (confirmEnrol), so a
 * leaked link can't put someone else's key on the vault.
 */
export const startEnrol = mutation({
  args: { purpose: v.optional(v.union(v.literal("first"), v.literal("backup"))) },
  handler: async (ctx, { purpose = "first" }) => {
    const user = await requireViewer(ctx);
    let w = await walletOf(ctx, user._id);
    if (purpose === "backup") {
      if (w?.status !== "live" || !isVaultVersion(w.version)) throw new Error("Put the wallet on-chain first");
      if ((w.passkeys ?? []).filter((p) => p.status !== "removed").length >= 3) throw new Error("You already have three passkeys");
    } else {
      if (!w) {
        const id = await ctx.db.insert("wallets", {
          userId: user._id,
          address: "",
          chain: "base-sepolia",
          asset: "USDC",
          balanceMinor: 0,
          protectedMinor: 5_000,
          dailyCeilingMinor: 2_000,
          perPaymentMinor: 1_000,
          frozen: false,
        });
        w = (await ctx.db.get(id))!;
      }
      if (w.status === "live" || w.status === "deploying") throw new Error("Your wallet already has a passkey");
      if (isSandbox(user) && w.deployRequestedAt) throw new Error("Each demo account can create one vault");
    }
    const token = newApprovalToken();
    const challenge = base64url(crypto.getRandomValues(new Uint8Array(32)));
    await ctx.db.patch(w._id, {
      status: purpose === "first" ? "enrolling" : w.status,
      enrolToken: token,
      enrolChallenge: challenge,
      enrolExpiresAt: Date.now() + ENROL_MINUTES * 60_000,
      candidate: undefined,
      statusNote: undefined,
    });
    return token;
  },
});

export const enrolInfo = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    if (token.length < 16) return null;
    const w = await ctx.db.query("wallets").withIndex("by_enrol_token", (q) => q.eq("enrolToken", token)).unique();
    if (!w || !w.enrolChallenge || (w.enrolExpiresAt ?? 0) < Date.now()) return null;
    const user = await ctx.db.get(w.userId);
    return {
      name: user?.name ?? "",
      userHandle: w._id,
      challenge: w.enrolChallenge,
      purpose: w.status === "live" ? ("backup" as const) : ("first" as const),
      dailyCeilingMinor: w.dailyCeilingMinor,
      perPaymentMinor: w.perPaymentMinor ?? w.dailyCeilingMinor,
      protectedMinor: w.protectedMinor,
      expiresAt: w.enrolExpiresAt!,
    };
  },
});

function hexToBytes(hex: string) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2) throw new Error("Bad hex");
  return Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
}

function find(bytes: Uint8Array, pattern: number[], from: number) {
  for (let i = from; i <= bytes.length - pattern.length; i++) if (pattern.every((p, j) => bytes[i + j] === p)) return i;
  return -1;
}

const toHex = (b: Uint8Array) => `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;

/**
 * Check the registration the browser produced: our challenge, our site, user verification, and
 * that the public key we were sent is the one inside the authenticator data.
 */
async function verifyRegistration(args: { clientDataJSON: string; authenticatorData: string; x: string; y: string; rpId: string }, challenge: string) {
  let client: { type?: string; challenge?: string; origin?: string };
  try {
    client = JSON.parse(args.clientDataJSON);
  } catch {
    throw new Error("Bad registration");
  }
  if (client.type !== "webauthn.create" || client.challenge !== challenge) throw new Error("This passkey wasn't made for this setup link");
  const origin = client.origin ?? "";
  const originOk = origin === `https://${args.rpId}` || (args.rpId === "localhost" && /^http:\/\/localhost:\d+$/.test(origin));
  if (!originOk) throw new Error("Passkeys can only be made on the approval site");
  const auth = hexToBytes(args.authenticatorData);
  if (auth.length < 55) throw new Error("Bad registration");
  const rpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(args.rpId)));
  if (!rpIdHash.every((b, i) => b === auth[i])) throw new Error("Passkeys can only be made on the approval site");
  const flags = auth[32]!;
  if (!(flags & 0x01) || !(flags & 0x04) || !(flags & 0x40)) throw new Error("This passkey must use Face ID, a fingerprint or your device PIN");
  const credLen = (auth[53]! << 8) | auth[54]!;
  const cose = 55 + credLen;
  const xi = find(auth, [0x21, 0x58, 0x20], cose);
  const yi = find(auth, [0x22, 0x58, 0x20], cose);
  if (xi < 0 || yi < 0) throw new Error("That isn't a P-256 passkey");
  if (toHex(auth.slice(xi + 3, xi + 35)).toLowerCase() !== args.x.toLowerCase() || toHex(auth.slice(yi + 3, yi + 35)).toLowerCase() !== args.y.toLowerCase()) {
    throw new Error("The passkey's public key doesn't match");
  }
}

/** Step two, on the approval site: record the new passkey and show its holder a code for the app. */
export const completeEnrol = mutation({
  args: {
    token: v.string(),
    credentialId: v.string(),
    x: v.string(),
    y: v.string(),
    rpId: v.string(),
    clientDataJSON: v.string(),
    authenticatorData: v.string(),
    device: v.string(),
  },
  handler: async (ctx, args) => {
    const w = await ctx.db.query("wallets").withIndex("by_enrol_token", (q) => q.eq("enrolToken", args.token)).unique();
    if (!w || !w.enrolChallenge || (w.enrolExpiresAt ?? 0) < Date.now()) throw new Error("This setup link expired. Start again from the app.");
    if (!HEX32.test(args.x) || !HEX32.test(args.y)) throw new Error("That isn't a P-256 passkey");
    if (!/^[A-Za-z0-9_-]{16,400}$/.test(args.credentialId)) throw new Error("Bad credential");
    if (!allowedRpIds().includes(args.rpId)) throw new Error("Passkeys can only be made on the approval site");
    if (args.clientDataJSON.length > 2000 || args.authenticatorData.length > 4000) throw new Error("Registration too large");
    await verifyRegistration(args, w.enrolChallenge);
    const digits = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
    const code = String(digits).padStart(6, "0");
    await ctx.db.patch(w._id, {
      // The link is used up: nobody else can enrol with it now.
      enrolToken: undefined,
      enrolChallenge: undefined,
      enrolExpiresAt: Date.now() + ENROL_MINUTES * 60_000,
      candidate: {
        x: args.x,
        y: args.y,
        credentialId: args.credentialId,
        rpId: args.rpId,
        code,
        device: args.device.slice(0, 60),
        at: Date.now(),
        purpose: w.status === "live" ? "backup" : "first",
      },
    });
    await ctx.db.insert("activity", { userId: w.userId, kind: "security", title: "A passkey was created from your setup link", detail: `${args.device.slice(0, 60)} · waiting for you to confirm`, tone: "warn" });
    return code;
  },
});

/** Step three, in the signed-in app: the owner types the code their phone shows. Only then is it used. */
export const confirmEnrol = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const user = await requireViewer(ctx);
    const w = await walletOf(ctx, user._id);
    const c = w?.candidate;
    if (!w || !c || (w.enrolExpiresAt ?? 0) < Date.now()) throw new Error("No passkey is waiting. Start again.");
    await hit(ctx, `enrol-confirm:${w._id}`, 5, 15 * 60_000);
    if (code.replace(/\s/g, "") !== c.code) throw new Error("That code doesn't match. Check the phone that made the passkey.");
    const keyId = keyIdOf(c.x as Hex, c.y as Hex);
    const entry = { keyId, x: c.x, y: c.y, credentialId: c.credentialId, rpId: c.rpId, label: c.device || "Passkey", addedAt: Date.now() };

    if (c.purpose === "backup") {
      const rpIdHash = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(c.rpId)))) as Hex;
      const task = await addKeyTask(ctx, user, { keyId, x: c.x, y: c.y, rpIdHash, label: entry.label });
      await ctx.db.patch(w._id, { candidate: undefined, passkeys: [...(w.passkeys ?? []), { ...entry, status: "adding" as const }] });
      return { approvalToken: task.token };
    }

    if (!chainReady()) throw new Error("The wallet network isn't configured yet");
    // Each vault costs the relayer test ETH: per visitor, per day for all sandboxes, and a reserve.
    await spendDeploy(ctx, user);
    await ctx.db.patch(w._id, {
      status: "deploying",
      candidate: undefined,
      keyX: c.x,
      keyY: c.y,
      credentialId: c.credentialId,
      rpId: c.rpId,
      passkeys: [{ ...entry, status: "active" as const }],
      deployRequestedAt: Date.now(),
    });
    await ctx.db.insert("activity", { userId: user._id, kind: "security", title: "Payment passkey confirmed", detail: `${entry.label} · for ${c.rpId}`, tone: "good" });
    await relayer.enqueueAction(ctx, internal.chain.deployVault, { walletId: w._id });
    return { approvalToken: null };
  },
});

/** "That wasn't me": drop the waiting passkey. */
export const rejectEnrol = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireViewer(ctx);
    const w = await walletOf(ctx, user._id);
    if (!w?.candidate) return;
    await ctx.db.patch(w._id, { candidate: undefined, enrolToken: undefined, enrolChallenge: undefined, status: w.status === "enrolling" ? undefined : w.status });
    await ctx.db.insert("activity", { userId: user._id, kind: "security", title: "Rejected a passkey you didn't make", detail: w.candidate.device, tone: "bad" });
  },
});

/**
 * Move a first-version vault to the current contract, using the same passkey. Funds in the old
 * vault are test tokens and stay there as evidence; the new vault gets fresh test funds.
 */
export const upgradeVault = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireViewer(ctx);
    const w = await walletOf(ctx, user._id);
    if (!w || w.status !== "live" || (w.version ?? 1) >= VAULT_VERSION || !w.keyX) throw new Error("Nothing to upgrade");
    await spendDeploy(ctx, user);
    const agents = await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50);
    for (const a of agents) {
      for (const k of await ctx.db.query("agentKeys").withIndex("by_agent", (q) => q.eq("agentId", a._id)).take(5)) await ctx.db.delete(k._id);
      if (a.chainAddress) await ctx.db.patch(a._id, { chainAddress: undefined, onchain: undefined, vault: undefined, freezing: undefined });
    }
    for (const p of await ctx.db.query("payees").withIndex("by_user", (q) => q.eq("userId", user._id)).take(200)) {
      if (p.onchain) await ctx.db.patch(p._id, { onchain: false });
    }
    await ctx.db.patch(w._id, {
      status: "deploying",
      previous: [...(w.previous ?? []), { address: w.address, version: w.version ?? 1, retiredAt: Date.now() }],
      address: "",
      vault: undefined,
      frozen: false,
      deployRequestedAt: Date.now(),
      passkeys: w.passkeys ?? [
        { keyId: w.keyId ?? keyIdOf(w.keyX as Hex, w.keyY as Hex), x: w.keyX, y: w.keyY!, credentialId: w.credentialId ?? "", rpId: w.rpId ?? "", label: "Payment passkey", addedAt: Date.now(), status: "active" as const },
      ],
    });
    await ctx.db.insert("activity", { userId: user._id, kind: "setting", title: "Moving to the current vault contract", detail: `Old vault ${w.address.slice(0, 10)}… kept as history`, tone: "neutral" });
    await relayer.enqueueAction(ctx, internal.chain.deployVault, { walletId: w._id });
  },
});

/**
 * Cap what all agents together may pay one contact in 24 hours (0 removes it). The vault enforces
 * it from v3. A lower cap applies to our checks at once; a higher one when the vault applies it.
 */
export const setContactCap = mutation({
  args: { payeeId: v.id("payees"), dailyCapMinor: v.number() },
  handler: async (ctx, { payeeId, dailyCapMinor }) => {
    const user = await requireViewer(ctx);
    if (!Number.isInteger(dailyCapMinor) || dailyCapMinor < 0 || dailyCapMinor > 100_000_000) throw new Error("Amount is out of range");
    const payee = await ctx.db.get(payeeId);
    if (!payee || payee.userId !== user._id) throw new Error("Not found");
    const w = await walletOf(ctx, user._id);
    if (w?.status !== "live" || (w.version ?? 0) < 3) throw new Error("Contact limits need the current vault. Move to it first.");
    if (!payee.onchain) throw new Error("Approve this contact in the vault first");
    await hit(ctx, `contact-cap:${user._id}`, 10, 60_000);
    const old = payee.dailyCapMinor ?? 0;
    const tighter = dailyCapMinor > 0 && (old === 0 || dailyCapMinor < old);
    if (tighter) await ctx.db.patch(payeeId, { dailyCapMinor });
    const task = await contactCapTask(ctx, user, payee, w, dailyCapMinor);
    return task.token;
  },
});

/** Read the vault again now. */
export const refresh = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireViewer(ctx);
    const w = await walletOf(ctx, user._id);
    if (w?.status !== "live" || !isVaultVersion(w.version)) return;
    await hit(ctx, `refresh:${w._id}`, 10, 60_000);
    await ctx.scheduler.runAfter(0, internal.chain.syncVault, { walletId: w._id });
  },
});

/** Stop a held agent payment or a queued loosening. Both only tighten, so no passkey is needed. */
export const cancelWaiting = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const user = await requireViewer(ctx);
    const t = await ctx.db.get(taskId);
    if (!t || t.userId !== user._id) throw new Error("Not found");
    if (t.state === "held") await relayer.enqueueAction(ctx, internal.chain.cancelHeld, { taskId });
    else if (t.state === "queued") await relayer.enqueueAction(ctx, internal.chain.cancelChange, { taskId });
    else throw new Error("This can't be cancelled any more");
    await ctx.db.patch(taskId, { reason: "Cancelling…", updatedAt: Date.now() });
  },
});

// ------------------------------------------------------------- internal: chain I/O

export const walletForChain = internalQuery({
  args: { walletId: v.id("wallets") },
  handler: async (ctx, { walletId }) => {
    const w = await ctx.db.get(walletId);
    if (!w) return null;
    const agents = await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", w.userId)).take(50);
    return {
      ...w,
      agents: agents.map((a) => ({ _id: a._id, chainAddress: a.chainAddress })),
      spendingAgents: agents.filter((a) => a.status === "active" && a.scopes.includes("spend") && !a.chainAddress).map((a) => a._id),
    };
  },
});

export const onDeployed = internalMutation({
  args: {
    walletId: v.id("wallets"),
    address: v.string(),
    keyId: v.string(),
    version: v.number(),
    tokenAddress: v.string(),
    deployTx: v.string(),
    agentKeys: v.array(v.object({ agentId: v.id("agents"), address: v.string(), privateKey: v.string() })),
  },
  handler: async (ctx, a) => {
    const w = await ctx.db.get(a.walletId);
    if (!w) return;
    const user = (await ctx.db.get(w.userId))!;
    await ctx.db.patch(w._id, { status: "live", version: a.version, address: a.address, keyId: a.keyId, tokenAddress: a.tokenAddress, deployTx: a.deployTx, statusNote: undefined, frozen: false });
    for (const k of a.agentKeys) {
      await ctx.db.insert("agentKeys", k);
      await ctx.db.patch(k.agentId, { chainAddress: k.address, onchain: false });
    }
    const payees = await ctx.db.query("payees").withIndex("by_user", (q) => q.eq("userId", user._id)).take(200);
    for (const p of payees) if (!p.address) await ctx.db.patch(p._id, { address: testPayeeAddress(p.name) });
    const agents = (await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50)).filter(
      (x) => x.chainAddress && !x.onchain && x.status === "active",
    );
    const fresh = (await ctx.db.query("payees").withIndex("by_user", (q) => q.eq("userId", user._id)).take(200)).filter((p) => !p.onchain);
    const wallet = (await ctx.db.get(w._id))!;
    const setup = await setupTask(ctx, user, agents, fresh, "Set up your wallet", wallet);
    await ctx.db.insert("activity", {
      userId: user._id,
      kind: "setting",
      title: "Wallet deployed on Base Sepolia",
      detail: `${a.address.slice(0, 10)}… · funded with $100 test dollars`,
      tone: "good",
    });
    await ctx.db.insert("messages", {
      userId: user._id,
      role: "assistant",
      text: setup
        ? `Your wallet is live on Base Sepolia. One more approval registers ${agents.length} ${agents.length === 1 ? "agent" : "agents"}, ${fresh.length} contacts and your safety rules in it.`
        : "Your wallet is live on Base Sepolia.",
      channel: "app",
      taskId: setup?.taskId,
    });
  },
});

export const onError = internalMutation({
  args: { walletId: v.id("wallets"), note: v.string(), keepLive: v.optional(v.boolean()) },
  handler: async (ctx, { walletId, note, keepLive }) => {
    const w = await ctx.db.get(walletId);
    if (!w) return;
    if (!keepLive) await ctx.db.patch(walletId, { status: "error", statusNote: note.slice(0, 200) });
    await ctx.db.insert("activity", { userId: w.userId, kind: "security", title: "Wallet network error", detail: note.slice(0, 160), tone: "bad" });
  },
});

export const taskForChain = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const t = await ctx.db.get(taskId);
    if (!t) return null;
    const w = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", t.userId)).unique();
    return { action: t.action, vault: w?.address, walletId: w!._id, state: t.state, changeId: t.changeId, txHash: t.txHash };
  },
});

export const agentTaskForChain = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const t = await ctx.db.get(taskId);
    if (!t?.agentId || !t.payeeId || !t.amountMinor || !t.paymentId) return null;
    const key = await ctx.db.query("agentKeys").withIndex("by_agent", (q) => q.eq("agentId", t.agentId!)).unique();
    const w = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", t.userId)).unique();
    if (!key || !w?.address) return null;
    return {
      agentId: t.agentId,
      agentKey: key.privateKey,
      agentAddress: key.address,
      vault: w.address,
      payeeId: t.payeeId,
      amountMinor: t.amountMinor,
      purpose: t.purpose,
      paymentId: t.paymentId,
      walletId: w._id,
    };
  },
});

export const heldForChain = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const t = await ctx.db.get(taskId);
    if (!t?.paymentId) return null;
    const w = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", t.userId)).unique();
    if (!w?.address) return null;
    return { vault: w.address, paymentId: t.paymentId, state: t.state, walletId: w._id };
  },
});

export const onSubmitted = internalMutation({
  args: { taskId: v.id("tasks"), txHash: v.string(), keepState: v.optional(v.boolean()) },
  handler: async (ctx, { taskId, txHash, keepState }) => {
    await ctx.db.patch(taskId, keepState ? { txHash, updatedAt: Date.now() } : { txHash, state: "submitted", updatedAt: Date.now() });
  },
});

/** Broadcast but no receipt yet: never call it failed, since it may still land. */
export const onUnknown = internalMutation({
  args: { taskId: v.id("tasks"), txHash: v.string(), note: v.string() },
  handler: async (ctx, { taskId, txHash }) => {
    await ctx.db.patch(taskId, { state: "unknown", txHash, reason: "Sent; checking the network before doing anything else", checks: 0, updatedAt: Date.now() });
  },
});

export const onChecked = internalMutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const t = await ctx.db.get(taskId);
    const checks = (t?.checks ?? 0) + 1;
    await ctx.db.patch(taskId, {
      checks,
      reason: checks >= 20 ? "Still not on the network after 10 minutes. Check the explorer link before retrying." : t?.reason,
      updatedAt: Date.now(),
    });
    return checks;
  },
});

export const onQueued = internalMutation({
  args: { taskId: v.id("tasks"), txHash: v.string(), changeId: v.string(), readyAt: v.number() },
  handler: async (ctx, { taskId, txHash, changeId, readyAt }) => {
    const t = await ctx.db.get(taskId);
    if (!t) return;
    await ctx.db.patch(taskId, { state: "queued", txHash, changeId, readyAt, reason: "Approved. Loosening waits before it applies; you can still cancel.", updatedAt: Date.now() });
    await ctx.db.insert("activity", { userId: t.userId, kind: "security", title: `${t.title}: waiting`, detail: `Applies at ${new Date(readyAt).toISOString().slice(11, 16)} UTC unless you cancel`, tone: "warn" });
  },
});

async function applyEffects(ctx: MutationCtx, t: Doc<"tasks">) {
  const e = t.effects;
  if (!e) return;
  for (const a of e.agents) await ctx.db.patch(a, { onchain: true });
  for (const p of e.payees) await ctx.db.patch(p, { onchain: true });
  if (e.contactCap) await ctx.db.patch(e.contactCap.payeeId, { dailyCapMinor: e.contactCap.dailyCapMinor || undefined });
  if (e.grant) {
    const g = e.grant;
    await ctx.db.patch(g.agentId, {
      perPaymentMinor: g.perPaymentMinor,
      dailyCapMinor: g.dailyCapMinor,
      expiresAt: g.expiresAt,
      ...(g.scopes ? { scopes: g.scopes as Doc<"agents">["scopes"] } : {}),
    });
  }
  if (e.removeAgent) await ctx.db.patch(e.removeAgent, { onchain: false, status: "revoked" });
  const w = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", t.userId)).unique();
  if (e.policy && w?.proposedPolicy?.taskId === t._id) {
    const p = w.proposedPolicy;
    await ctx.db.patch(w._id, { protectedMinor: p.protectedMinor, dailyCeilingMinor: p.dailyCeilingMinor, perPaymentMinor: p.perPaymentMinor, proposedPolicy: undefined });
  }
  if (e.passkey && w?.passkeys) {
    await ctx.db.patch(w._id, { passkeys: w.passkeys.map((k) => (k.keyId === e.passkey ? { ...k, status: "active" as const } : k)) });
  }
}

export const onOwnerResult = internalMutation({
  args: { taskId: v.id("tasks"), txHash: v.optional(v.string()), ok: v.boolean(), note: v.optional(v.string()) },
  handler: async (ctx, { taskId, txHash, ok, note }) => {
    const t = await ctx.db.get(taskId);
    if (!t) return;
    await ctx.db.patch(taskId, { state: ok ? "confirmed" : "failed", txHash: txHash ?? t.txHash, reason: ok ? t.reason : `Not done: ${note ?? "rejected"}`, updatedAt: Date.now() });
    if (!ok) {
      await ctx.db.insert("activity", { userId: t.userId, kind: "payment", title: `${t.title} failed`, detail: note, tone: "bad" });
      // Nothing changed in the vault, so offer the same setup again with a fresh nonce.
      if (t.effects && (t.effects.agents.length || t.effects.payees.length)) {
        const user = (await ctx.db.get(t.userId))!;
        const agents = (await Promise.all(t.effects.agents.map((id) => ctx.db.get(id)))).filter((a) => a && a.chainAddress && !a.onchain);
        const payees = (await Promise.all(t.effects.payees.map((id) => ctx.db.get(id)))).filter((p) => p && !p.onchain);
        const w = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", t.userId)).unique();
        const again = await setupTask(ctx, user, agents as Doc<"agents">[], payees as Doc<"payees">[], t.title, t.effects.policy ? w : null, w?.version);
        if (again) {
          await ctx.db.insert("messages", { userId: t.userId, role: "assistant", text: `${t.title} didn't go through, and nothing changed. Approve it again when you're ready.`, channel: "app", taskId: again.taskId });
        }
      }
      return;
    }
    await applyEffects(ctx, t);
    if (t.action?.op === Op.Unfreeze) {
      const w = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", t.userId)).unique();
      if (t.agentId) await ctx.db.patch(t.agentId, { status: "active", freezing: undefined });
      else if (w) await ctx.db.patch(w._id, { frozen: false });
    }
    const payee = t.payeeId ? await ctx.db.get(t.payeeId) : null;
    const label = t.amountMinor ? formatMoney(t.amountMinor, "USDC") : "";
    await ctx.db.insert("activity", {
      userId: t.userId,
      kind: t.action?.op === Op.Pay ? "payment" : "setting",
      title: t.action?.op === Op.Pay ? `Paid ${payee?.name ?? t.title} ${label}` : `${t.title} done`,
      detail: "Approved with your passkey · on Base Sepolia",
      tone: "good",
    });
    await ctx.db.insert("messages", {
      userId: t.userId,
      role: "assistant",
      text: t.action?.op === Op.Pay ? `Done. ${payee?.name ?? t.title} has been paid ${label}.` : `Done. ${t.title}.`,
      channel: "app",
      taskId,
    });
  },
});

export const onHeld = internalMutation({
  args: { taskId: v.id("tasks"), txHash: v.string(), releaseAt: v.number() },
  handler: async (ctx, { taskId, txHash, releaseAt }) => {
    const t = await ctx.db.get(taskId);
    if (!t) return;
    await ctx.db.patch(taskId, { state: "held", txHash, releaseAt, reason: "Held so you can cancel it before it leaves", updatedAt: Date.now() });
    const agent = t.agentId ? await ctx.db.get(t.agentId) : null;
    const payee = t.payeeId ? await ctx.db.get(t.payeeId) : null;
    await ctx.db.insert("activity", {
      userId: t.userId,
      kind: "payment",
      title: `${agent?.name ?? "Agent"} → ${payee?.name ?? ""} ${formatMoney(t.amountMinor ?? 0, "USDC")} held`,
      detail: `Leaves at ${new Date(releaseAt).toISOString().slice(11, 16)} UTC unless you cancel`,
      tone: "warn",
    });
    if (process.env.TELEGRAM_BOT_TOKEN && agent?.provider !== "own") {
      const minutes = Math.max(1, Math.round((releaseAt - Date.now()) / 60_000));
      await ctx.scheduler.runAfter(0, internal.telegram.send, {
        userId: t.userId,
        text: `Held: ${agent?.name ?? "An agent"} is paying ${payee?.name ?? "a contact"} ${formatMoney(t.amountMinor ?? 0, "USDC")}. It leaves in about ${minutes} min unless you cancel it on the Wallet screen.`,
      });
    }
  },
});

export const onAgentResult = internalMutation({
  args: { taskId: v.id("tasks"), txHash: v.optional(v.string()), ok: v.boolean(), code: v.optional(v.number()), note: v.optional(v.string()) },
  handler: async (ctx, { taskId, txHash, ok, code, note }) => {
    const t = await ctx.db.get(taskId);
    if (!t) return;
    const why = code ? `Refused by the vault: ${REFUSAL[code] ?? `code ${code}`}` : note;
    await ctx.db.patch(taskId, { state: ok ? "confirmed" : "failed", txHash: txHash ?? t.txHash, refusalCode: code, reason: ok ? t.reason : why, updatedAt: Date.now() });
    const agent = t.agentId ? await ctx.db.get(t.agentId) : null;
    const payee = t.payeeId ? await ctx.db.get(t.payeeId) : null;
    if (ok && agent) await ctx.db.patch(agent._id, { lastUsedAt: Date.now() });
    await ctx.db.insert("activity", {
      userId: t.userId,
      kind: "payment",
      title: ok ? `${agent?.name ?? "Agent"} paid ${payee?.name ?? ""} ${formatMoney(t.amountMinor ?? 0, "USDC")}` : `${agent?.name ?? "Agent"}'s payment refused`,
      detail: ok ? "Within its limits · on Base Sepolia" : why,
      tone: ok ? "good" : "bad",
    });
  },
});

export const onCancelled = internalMutation({
  args: { taskId: v.id("tasks"), txHash: v.string() },
  handler: async (ctx, { taskId, txHash }) => {
    const t = await ctx.db.get(taskId);
    if (!t) return;
    await ctx.db.patch(taskId, { state: "cancelled", reason: `Cancelled on-chain · ${txHash.slice(0, 10)}…`, updatedAt: Date.now() });
    if (t.effects?.passkey) {
      const w = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", t.userId)).unique();
      if (w?.passkeys) await ctx.db.patch(w._id, { passkeys: w.passkeys.map((k) => (k.keyId === t.effects!.passkey ? { ...k, status: "removed" as const } : k)) });
    }
    await ctx.db.insert("activity", { userId: t.userId, kind: "security", title: `Cancelled: ${t.title}`, tone: "neutral" });
  },
});

export const onCancelFailed = internalMutation({
  args: { taskId: v.id("tasks"), note: v.string() },
  handler: async (ctx, { taskId, note }) => {
    const t = await ctx.db.get(taskId);
    if (!t) return;
    await ctx.db.patch(taskId, { reason: `Couldn't cancel: ${note}`, updatedAt: Date.now() });
  },
});

/** A guardian freeze, confirmed only by reading the vault back. */
export const onFreezeResult = internalMutation({
  args: { walletId: v.id("wallets"), agentId: v.optional(v.id("agents")), ok: v.boolean(), txHash: v.optional(v.string()), note: v.optional(v.string()) },
  handler: async (ctx, { walletId, agentId, ok, txHash, note }) => {
    const w = await ctx.db.get(walletId);
    if (!w) return;
    const agent = agentId ? await ctx.db.get(agentId) : null;
    if (agent) await ctx.db.patch(agent._id, { freezing: ok ? undefined : true });
    else if (ok) await ctx.db.patch(walletId, { frozen: true });
    await ctx.db.insert("activity", {
      userId: w.userId,
      kind: "security",
      title: ok ? (agent ? `${agent.name} frozen in the vault` : "Vault frozen") : `Freeze not confirmed${agent ? ` for ${agent.name}` : ""}`,
      detail: ok ? `Read back from Base Sepolia · ${txHash?.slice(0, 10)}…` : `${note ?? ""}. Our gateway still blocks it; try again.`,
      tone: ok ? "warn" : "bad",
    });
  },
});

/** The vault froze an agent itself after repeated refusals. */
export const onStruckOut = internalMutation({
  args: { walletId: v.id("wallets"), agentAddress: v.string() },
  handler: async (ctx, { walletId, agentAddress }) => {
    const w = await ctx.db.get(walletId);
    if (!w) return;
    const agent = (await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", w.userId)).take(50)).find(
      (a) => a.chainAddress?.toLowerCase() === agentAddress.toLowerCase(),
    );
    if (!agent) return;
    await ctx.db.patch(agent._id, { status: "frozen" });
    await ctx.db.insert("activity", { userId: w.userId, kind: "security", title: `${agent.name} froze itself`, detail: "Five refused payments in 24 hours. Unfreezing needs your passkey.", tone: "bad" });
  },
});

export const onVaultState = internalMutation({
  args: {
    walletId: v.id("wallets"),
    vault: v.object({
      version: v.number(),
      protectedMinor: v.number(),
      ceilingMinor: v.number(),
      contactDelay: v.number(),
      changeDelay: v.number(),
      holdAboveMinor: v.number(),
      holdFor: v.number(),
      frozen: v.boolean(),
      balanceMinor: v.number(),
      heldMinor: v.number(),
      spentMinor: v.number(),
      headroomMinor: v.number(),
      ownerKeys: v.number(),
      syncedAt: v.number(),
    }),
    agents: v.array(
      v.object({
        agentId: v.id("agents"),
        perPaymentMinor: v.number(),
        dailyCapMinor: v.number(),
        expiresAt: v.number(),
        active: v.boolean(),
        frozen: v.boolean(),
        strikes: v.number(),
        spentMinor: v.number(),
      }),
    ),
  },
  handler: async (ctx, { walletId, vault, agents }) => {
    await ctx.db.patch(walletId, { vault, balanceMinor: vault.balanceMinor, frozen: vault.frozen });
    for (const { agentId, ...a } of agents) {
      const agent = await ctx.db.get(agentId);
      if (!agent) continue;
      // The vault's own count of what this agent spent replaces ours.
      await ctx.db.patch(agentId, { vault: { ...a, syncedAt: vault.syncedAt }, spentTodayMinor: a.spentMinor, freezing: a.frozen ? undefined : agent.freezing });
    }
  },
});

export const onAgentKey = internalMutation({
  args: { agentId: v.id("agents"), address: v.string(), privateKey: v.string() },
  handler: async (ctx, { agentId, address, privateKey }) => {
    const agent = await ctx.db.get(agentId);
    if (!agent || agent.chainAddress) return;
    await ctx.db.insert("agentKeys", { agentId, address, privateKey });
    await ctx.db.patch(agentId, { chainAddress: address, onchain: false });
    const user = (await ctx.db.get(agent.userId))!;
    const fresh = (await ctx.db.get(agentId))!;
    const setup = await setupTask(ctx, user, [fresh], [], `Let ${agent.name} pay within limits`);
    if (setup) {
      await ctx.db.insert("messages", {
        userId: user._id,
        role: "assistant",
        text: `${agent.name} can pay once you approve its limits with your passkey.`,
        channel: "app",
        taskId: setup.taskId,
      });
    }
  },
});
