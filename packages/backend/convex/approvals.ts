import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { CHAIN_ID, EXPLORER, Op, actionDigest, assertionProblem } from "@agent-wallet/domain";
import type { Address, Hex } from "viem";
import { requireViewer } from "./lib/auth";
import { laneOf, lanePool } from "./lib/relayer";

/**
 * The approval link carries an opaque token. Opening it only reads; nothing is
 * consumed until the owner decides. Passkey signing replaces the plain decision next.
 */
export const get = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    if (token.length < 16) return null;
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_approval_token", (q) => q.eq("approvalToken", token))
      .unique();
    if (!task) return null;
    const [payee, agent, wallet] = await Promise.all([
      task.payeeId ? ctx.db.get(task.payeeId) : null,
      task.agentId ? ctx.db.get(task.agentId) : null,
      ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", task.userId)).unique(),
    ]);
    let onchain = null;
    if (task.action && wallet?.address && wallet.keyId) {
      // Names only for addresses that appear in the signed bytes; nothing else about the account.
      // The page checks payees against the vault itself (contacts are keyed by contactIdOf(payeeId)).
      const bytes = task.action.data.toLowerCase();
      const inBytes = (addr?: string) => Boolean(addr && bytes.includes(addr.slice(2).toLowerCase()));
      const names: Record<string, string> = {};
      const contacts: { payeeId: string; name: string; address: string }[] = [];
      for (const p of await ctx.db.query("payees").withIndex("by_user", (q) => q.eq("userId", task.userId)).take(200)) {
        if (!p.address || !inBytes(p.address)) continue;
        names[p.address.toLowerCase()] = p.name;
        contacts.push({ payeeId: p._id, name: p.name, address: p.address });
      }
      for (const a of await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", task.userId)).take(50)) {
        if (a.chainAddress && inBytes(a.chainAddress)) names[a.chainAddress.toLowerCase()] = a.name;
      }
      const keys = (wallet.passkeys ?? []).filter((k) => k.status !== "removed");
      for (const k of keys) names[k.keyId] = k.label;
      for (const rp of new Set(keys.map((k) => k.rpId))) {
        const h = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rp))), (b) => b.toString(16).padStart(2, "0")).join("");
        names[`0x${h}`] = rp;
      }
      onchain = {
        action: task.action,
        vault: wallet.address,
        chainId: CHAIN_ID,
        version: wallet.version ?? 1,
        changeDelay: wallet.vault?.changeDelay ?? 0,
        keyId: wallet.keyId,
        credentialIds: keys.filter((k) => k.status === "active").map((k) => k.credentialId),
        credentialId: wallet.credentialId ?? null,
        rpId: wallet.rpId ?? null,
        names,
        contacts,
      };
    }
    return {
      onchain,
      txHash: task.txHash ?? null,
      readyAt: task.readyAt ?? null,
      explorer: EXPLORER,
      title: task.title,
      state: task.state,
      amountMinor: task.amountMinor ?? 0,
      currency: task.currency ?? "USDC",
      purpose: task.purpose,
      reason: task.reason,
      rail: task.rail,
      channel: task.channel,
      expiresAt: task.expiresAt,
      payee: payee ? { name: payee.name, handle: payee.handle, trusted: payee.trusted, kind: payee.kind, address: payee.address ?? null } : null,
      agent: agent?.name,
      /** Which character to draw for it on the approval page (packages/brand → CAST). */
      agentProvider: agent?.provider,
    };
  },
});

/**
 * Approve or decline a request that has no passkey step (simulator and UPI hand-off rails), or
 * decline any request. Only the signed-in owner can: the approval token alone proves nothing,
 * since it travels in links and notifications.
 */
export const decide = mutation({
  args: { token: v.string(), approve: v.boolean() },
  handler: async (ctx, { token, approve }) => {
    const user = await requireViewer(ctx);
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_approval_token", (q) => q.eq("approvalToken", token))
      .unique();
    if (!task || task.userId !== user._id) throw new ConvexError("This link is no longer valid");
    if (task.state !== "awaiting_approval") return task.state;
    if (task.expiresAt && task.expiresAt < Date.now()) {
      await ctx.db.patch(task._id, { state: "expired", updatedAt: Date.now() });
      return "expired";
    }
    if (approve && task.action) throw new ConvexError("Approve this with your passkey");
    if (!approve) {
      await ctx.db.patch(task._id, { state: "cancelled", updatedAt: Date.now() });
      await ctx.db.insert("activity", { userId: task.userId, kind: "payment", title: `Declined ${task.title}`, tone: "neutral" });
      return "cancelled";
    }
    // A settings request from an assistant on a simulated wallet (new limits, a new trusted contact):
    // the signed-in owner's yes applies it here, since there is no vault to sign for.
    if (task.effects && task.amountMinor === undefined) {
      const g = task.effects.grant;
      if (g) {
        const agent = await ctx.db.get(g.agentId);
        if (agent && agent.userId === user._id && agent.status !== "revoked") {
          const scopes = (g.scopes ?? agent.scopes).filter((s): s is "read" | "prepare" | "spend" | "request" => ["read", "prepare", "spend", "request"].includes(s));
          await ctx.db.patch(agent._id, { perPaymentMinor: g.perPaymentMinor, dailyCapMinor: g.dailyCapMinor, expiresAt: g.expiresAt, scopes });
        }
      }
      for (const payeeId of task.effects.payees) {
        const p = await ctx.db.get(payeeId);
        if (p && p.userId === user._id) await ctx.db.patch(p._id, { trusted: true, pendingPasskey: undefined, holdUntil: undefined });
      }
      await ctx.db.patch(task._id, { state: "confirmed", updatedAt: Date.now() });
      await ctx.db.insert("activity", { userId: task.userId, kind: "setting", title: `Approved: ${task.title}`, tone: "good" });
      return "confirmed";
    }
    await ctx.db.patch(task._id, { state: "submitted", updatedAt: Date.now() });
    await ctx.scheduler.runAfter(1600, internal.tasks.settle, { taskId: task._id });
    return "submitted";
  },
});

/**
 * Decline from the approval page itself. The link's token is enough: declining only stops a
 * request (nothing is paid or loosened), so it needs neither sign-in nor the passkey.
 */
export const decline = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    if (token.length < 16) throw new ConvexError("This link is no longer valid");
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_approval_token", (q) => q.eq("approvalToken", token))
      .unique();
    if (!task) throw new ConvexError("This link is no longer valid");
    if (task.state !== "awaiting_approval") return task.state;
    await ctx.db.patch(task._id, { state: "cancelled", reason: "Declined on the approval page", updatedAt: Date.now() });
    await ctx.db.insert("activity", { userId: task.userId, kind: task.amountMinor ? "payment" : "setting", title: `Declined ${task.title}`, detail: "Nothing was paid or changed", tone: "neutral" });
    return "cancelled";
  },
});

/** The passkey signed the exact action. The relayer submits it; the vault checks the signature itself. */
export const submit = mutation({
  args: {
    token: v.string(),
    auth: v.object({
      r: v.string(),
      s: v.string(),
      challengeIndex: v.number(),
      typeIndex: v.number(),
      authenticatorData: v.string(),
      clientDataJSON: v.string(),
    }),
    /** Which of the owner's passkeys signed (by credential id). */
    credentialId: v.optional(v.string()),
  },
  handler: async (ctx, { token, auth, credentialId }) => {
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_approval_token", (q) => q.eq("approvalToken", token))
      .unique();
    if (!task?.action) throw new ConvexError("This link is no longer valid");
    if (task.state !== "awaiting_approval") return task.state;
    if (task.action.deadline * 1000 < Date.now()) {
      await ctx.db.patch(task._id, { state: "expired", updatedAt: Date.now() });
      return "expired";
    }
    if (auth.clientDataJSON.length > 2000 || auth.authenticatorData.length > 1000) throw new ConvexError("Signature too large");
    const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", task.userId)).unique();
    if (!wallet?.address) throw new ConvexError("This wallet has no vault");
    const keys = (wallet.passkeys ?? []).filter((k) => k.status === "active");
    const key = credentialId ? keys.find((k) => k.credentialId === credentialId) : keys[0];
    const x = key?.x ?? wallet.keyX;
    const y = key?.y ?? wallet.keyY;
    const rpId = key?.rpId ?? wallet.rpId;
    const keyId = key?.keyId ?? wallet.keyId;
    if (!keyId || !x || !y || !rpId) throw new ConvexError("This wallet has no passkey");

    // Attempts are counted without throwing, so the count survives (a throw would roll it back).
    const limitKey = `approval-sign:${task._id}`;
    const row = await ctx.db.query("limits").withIndex("by_key", (q) => q.eq("key", limitKey)).unique();
    const fresh = !row || Date.now() - row.windowStart >= 15 * 60_000;
    if (!fresh && row.count >= 10) return "too_many_attempts";

    // Check the assertion here first: a bad one leaves the request open instead of failing it.
    const a = task.action;
    const digest = actionDigest({ op: a.op as Op, data: a.data as Hex, nonce: BigInt(a.nonce), deadline: BigInt(a.deadline) }, wallet.address as Address, CHAIN_ID);
    const problem = await assertionProblem({ auth, key: { x: x as Hex, y: y as Hex, rpId }, challenge: digest });
    if (problem) {
      if (fresh) {
        if (row) await ctx.db.patch(row._id, { windowStart: Date.now(), count: 1 });
        else await ctx.db.insert("limits", { key: limitKey, windowStart: Date.now(), count: 1 });
      } else {
        await ctx.db.patch(row._id, { count: row.count + 1 });
      }
      return "rejected";
    }
    await ctx.db.patch(task._id, { state: "reserved", updatedAt: Date.now() });
    const lane = laneOf(task.userId);
    await lanePool(lane).enqueueAction(ctx, internal.chain.relayOwner, { taskId: task._id, auth, keyId, lane });
    return "reserved";
  },
});
