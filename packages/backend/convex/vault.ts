import { v } from "convex/values";
import { EXPLORER, REFUSAL, Op, formatMoney, testPayeeAddress } from "@agent-wallet/domain";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireViewer, viewer } from "./lib/auth";
import { newApprovalToken } from "./lib/seed";
import { setupTask } from "./lib/actions";
import { chainReady } from "./chain";

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

function allowedRpIds() {
  return (process.env.RP_IDS ?? "agent-wallet-approve.vercel.app,localhost").split(",").map((s) => s.trim());
}

export const status = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return null;
    const w = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    if (!w) return { wallet: null, setup: null, ready: chainReady() };
    const pending = await ctx.db
      .query("tasks")
      .withIndex("by_user_state", (q) => q.eq("userId", user._id).eq("state", "awaiting_approval"))
      .take(50);
    const setup = pending.find((t) => t.action && (t.action.op === Op.Batch || t.action.op === Op.SetAgent || t.action.op === Op.AddContact));
    return {
      ready: chainReady(),
      wallet: {
        status: w.status ?? null,
        statusNote: w.statusNote,
        address: w.address || null,
        deployTx: w.deployTx,
        rpId: w.rpId,
        hasPasskey: Boolean(w.keyId),
        explorer: EXPLORER,
      },
      setup: setup ? { title: setup.title, token: setup.approvalToken } : null,
    };
  },
});

/** Step one of passkey enrolment: a one-time link to the approval site. */
export const startEnrol = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireViewer(ctx);
    let w = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
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
    const token = newApprovalToken();
    await ctx.db.patch(w._id, { status: "enrolling", enrolToken: token, enrolExpiresAt: Date.now() + 15 * 60_000, statusNote: undefined });
    return token;
  },
});

export const enrolInfo = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    if (token.length < 16) return null;
    const w = await ctx.db.query("wallets").withIndex("by_enrol_token", (q) => q.eq("enrolToken", token)).unique();
    if (!w || w.status !== "enrolling" || (w.enrolExpiresAt ?? 0) < Date.now()) return null;
    const user = await ctx.db.get(w.userId);
    return {
      name: user?.name ?? "",
      userHandle: w._id,
      dailyCeilingMinor: w.dailyCeilingMinor,
      perPaymentMinor: w.perPaymentMinor ?? w.dailyCeilingMinor,
      protectedMinor: w.protectedMinor,
      expiresAt: w.enrolExpiresAt!,
    };
  },
});

/** Step two: the approval site sends the new passkey's public key; the vault is deployed for it. */
export const completeEnrol = mutation({
  args: { token: v.string(), credentialId: v.string(), x: v.string(), y: v.string(), rpId: v.string() },
  handler: async (ctx, args) => {
    const w = await ctx.db.query("wallets").withIndex("by_enrol_token", (q) => q.eq("enrolToken", args.token)).unique();
    if (!w || w.status !== "enrolling" || (w.enrolExpiresAt ?? 0) < Date.now()) throw new Error("This setup link expired. Start again from the app.");
    if (!HEX32.test(args.x) || !HEX32.test(args.y)) throw new Error("That isn't a P-256 passkey");
    if (!/^[A-Za-z0-9_-]{16,400}$/.test(args.credentialId)) throw new Error("Bad credential");
    if (!allowedRpIds().includes(args.rpId)) throw new Error("Passkeys can only be made on the approval site");
    if (!chainReady()) throw new Error("The wallet network isn't configured yet");
    await ctx.db.patch(w._id, {
      status: "deploying",
      enrolToken: undefined,
      keyX: args.x,
      keyY: args.y,
      credentialId: args.credentialId,
      rpId: args.rpId,
    });
    await ctx.db.insert("activity", { userId: w.userId, kind: "security", title: "Payment passkey created", detail: `For ${args.rpId}`, tone: "good" });
    await ctx.scheduler.runAfter(0, internal.chain.deployVault, { walletId: w._id });
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
      spendingAgents: agents.filter((a) => a.status === "active" && a.scopes.includes("spend") && !a.chainAddress).map((a) => a._id),
    };
  },
});

export const onDeployed = internalMutation({
  args: {
    walletId: v.id("wallets"),
    address: v.string(),
    keyId: v.string(),
    tokenAddress: v.string(),
    deployTx: v.string(),
    agentKeys: v.array(v.object({ agentId: v.id("agents"), address: v.string(), privateKey: v.string() })),
  },
  handler: async (ctx, a) => {
    const w = await ctx.db.get(a.walletId);
    if (!w) return;
    const user = (await ctx.db.get(w.userId))!;
    await ctx.db.patch(w._id, { status: "live", address: a.address, keyId: a.keyId, tokenAddress: a.tokenAddress, deployTx: a.deployTx, statusNote: undefined, frozen: false });
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
    const setup = await setupTask(ctx, user, agents, fresh, "Set up your wallet");
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
        ? `Your wallet is live on Base Sepolia. One more approval registers ${agents.length} ${agents.length === 1 ? "agent" : "agents"} and ${fresh.length} contacts in it.`
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
    return { action: t.action, vault: w?.address, keyId: w?.keyId, walletId: w!._id };
  },
});

export const agentTaskForChain = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const t = await ctx.db.get(taskId);
    if (!t?.agentId || !t.payeeId || !t.amountMinor) return null;
    const key = await ctx.db.query("agentKeys").withIndex("by_agent", (q) => q.eq("agentId", t.agentId!)).unique();
    const w = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", t.userId)).unique();
    if (!key || !w?.address) return null;
    return { agentKey: key.privateKey, agentAddress: key.address, vault: w.address, payeeId: t.payeeId, amountMinor: t.amountMinor, purpose: t.purpose, walletId: w._id };
  },
});

export const onSubmitted = internalMutation({
  args: { taskId: v.id("tasks"), txHash: v.string() },
  handler: async (ctx, { taskId, txHash }) => {
    await ctx.db.patch(taskId, { txHash, state: "submitted", updatedAt: Date.now() });
  },
});

export const onOwnerResult = internalMutation({
  args: { taskId: v.id("tasks"), txHash: v.optional(v.string()), ok: v.boolean(), note: v.optional(v.string()) },
  handler: async (ctx, { taskId, txHash, ok, note }) => {
    const t = await ctx.db.get(taskId);
    if (!t) return;
    await ctx.db.patch(taskId, { state: ok ? "confirmed" : "failed", txHash: txHash ?? t.txHash, reason: ok ? t.reason : `Not sent: ${note ?? "rejected"}`, updatedAt: Date.now() });
    if (!ok) {
      await ctx.db.insert("activity", { userId: t.userId, kind: "payment", title: `${t.title} failed`, detail: note, tone: "bad" });
      return;
    }
    if (t.effects) {
      for (const a of t.effects.agents) await ctx.db.patch(a, { onchain: true });
      for (const p of t.effects.payees) await ctx.db.patch(p, { onchain: true });
    }
    if (t.action?.op === Op.Unfreeze) {
      const w = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", t.userId)).unique();
      if (t.agentId) await ctx.db.patch(t.agentId, { status: "active" });
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

export const onAgentResult = internalMutation({
  args: { taskId: v.id("tasks"), txHash: v.optional(v.string()), ok: v.boolean(), code: v.optional(v.number()), note: v.optional(v.string()) },
  handler: async (ctx, { taskId, txHash, ok, code, note }) => {
    const t = await ctx.db.get(taskId);
    if (!t) return;
    const why = code ? `Refused by the vault: ${REFUSAL[code] ?? `code ${code}`}` : note;
    await ctx.db.patch(taskId, { state: ok ? "confirmed" : "failed", txHash: txHash ?? t.txHash, refusalCode: code, reason: ok ? t.reason : why, updatedAt: Date.now() });
    const agent = t.agentId ? await ctx.db.get(t.agentId) : null;
    const payee = t.payeeId ? await ctx.db.get(t.payeeId) : null;
    if (ok && agent && t.amountMinor) await ctx.db.patch(agent._id, { spentTodayMinor: agent.spentTodayMinor + t.amountMinor, lastUsedAt: Date.now() });
    await ctx.db.insert("activity", {
      userId: t.userId,
      kind: "payment",
      title: ok ? `${agent?.name ?? "Agent"} paid ${payee?.name ?? ""} ${formatMoney(t.amountMinor ?? 0, "USDC")}` : `${agent?.name ?? "Agent"}'s payment refused`,
      detail: ok ? "Within its limits · on Base Sepolia" : why,
      tone: ok ? "good" : "bad",
    });
  },
});

export const onFrozen = internalMutation({
  args: { walletId: v.id("wallets"), txHash: v.string(), agent: v.optional(v.string()) },
  handler: async (ctx, { walletId, txHash, agent }) => {
    const w = await ctx.db.get(walletId);
    if (!w) return;
    await ctx.db.insert("activity", {
      userId: w.userId,
      kind: "security",
      title: agent ? "Agent frozen in the vault" : "Vault frozen",
      detail: `On Base Sepolia · ${txHash.slice(0, 10)}…`,
      tone: "warn",
    });
  },
});

export const onBalance = internalMutation({
  args: { walletId: v.id("wallets"), balanceMinor: v.number(), frozen: v.boolean() },
  handler: async (ctx, { walletId, balanceMinor, frozen }) => {
    await ctx.db.patch(walletId, { balanceMinor, frozen });
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
