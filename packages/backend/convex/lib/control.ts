import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { grantTask, removeAgentTask } from "./actions";
import { relayer } from "./relayer";

/**
 * The one place that freezes, disconnects or re-limits an agent. Every route (dashboard, chat,
 * Telegram, onboarding) calls these, so none of them can stop at the database while the agent's key
 * still works on the chain.
 */

async function walletOf(ctx: MutationCtx, user: Doc<"users">) {
  return await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
}

function onChain(wallet: Doc<"wallets"> | null, agent: Doc<"agents">) {
  return Boolean(wallet?.status === "live" && wallet.version === 2 && agent.chainAddress);
}

/** Freeze one agent: our gateway stops at once; the guardian freezes its key in the vault. */
export async function freezeAgent(ctx: MutationCtx, user: Doc<"users">, agent: Doc<"agents">) {
  const wallet = await walletOf(ctx, user);
  const chain = onChain(wallet, agent);
  await ctx.db.patch(agent._id, { status: agent.status === "revoked" ? "revoked" : "frozen", freezing: chain || undefined });
  if (chain) await relayer.enqueueAction(ctx, internal.chain.guardianFreeze, { walletId: wallet!._id, agentId: agent._id });
  return chain;
}

export async function freezeAll(ctx: MutationCtx, user: Doc<"users">, source: string) {
  const agents = await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50);
  let n = 0;
  for (const a of agents) {
    if (a.status !== "active" && a.status !== "pending") continue;
    await freezeAgent(ctx, user, a);
    n++;
  }
  await ctx.db.insert("activity", { userId: user._id, kind: "security", title: `Froze ${n} ${n === 1 ? "agent" : "agents"}`, detail: source, tone: "warn" });
  return n;
}

/**
 * Disconnect an outside assistant: its access key stops working now, its vault key is frozen now,
 * and the owner gets an approval to remove that key from the vault for good.
 */
export async function revokeAgent(ctx: MutationCtx, user: Doc<"users">, agent: Doc<"agents">) {
  const wallet = await walletOf(ctx, user);
  const chain = onChain(wallet, agent);
  await ctx.db.patch(agent._id, { status: "revoked", tokenHash: undefined, freezing: chain || undefined });
  let token: string | null = null;
  if (chain) {
    await relayer.enqueueAction(ctx, internal.chain.guardianFreeze, { walletId: wallet!._id, agentId: agent._id });
    if (agent.onchain) token = (await removeAgentTask(ctx, user, agent)).token;
  }
  await ctx.db.insert("activity", {
    userId: user._id,
    kind: "agent",
    title: `Disconnected ${agent.name}`,
    detail: chain ? "Its key is frozen in the vault" : undefined,
    tone: "warn",
  });
  return token;
}

/**
 * New scopes and limits for an agent. Tighter limits take effect in our gateway at once and in the
 * vault once signed; looser ones only after the vault applies them. Losing "spend" freezes the key.
 */
export async function changeLimits(
  ctx: MutationCtx,
  user: Doc<"users">,
  agent: Doc<"agents">,
  next: { scopes: Doc<"agents">["scopes"]; perPaymentMinor: number; dailyCapMinor: number; expiresAt: number },
) {
  const wallet = await walletOf(ctx, user);
  const chain = onChain(wallet, agent) && agent.onchain;
  const spends = next.scopes.includes("spend");
  if (!chain) {
    await ctx.db.patch(agent._id, { ...next, perPaymentMinor: spends ? next.perPaymentMinor : 0, dailyCapMinor: spends ? next.dailyCapMinor : 0 });
    if (spends && wallet?.status === "live" && wallet.version === 2 && !agent.chainAddress && agent.status === "active") {
      await ctx.scheduler.runAfter(0, internal.chain.provisionAgent, { agentId: agent._id });
    }
    return null;
  }
  if (!spends) {
    // It may still read and prepare through us; only its vault key stops.
    await ctx.db.patch(agent._id, { scopes: next.scopes, perPaymentMinor: 0, dailyCapMinor: 0, expiresAt: next.expiresAt, freezing: true });
    await relayer.enqueueAction(ctx, internal.chain.guardianFreeze, { walletId: wallet!._id, agentId: agent._id });
    return (await removeAgentTask(ctx, user, agent)).token;
  }
  const looser = next.perPaymentMinor > agent.perPaymentMinor || next.dailyCapMinor > agent.dailyCapMinor || next.expiresAt > agent.expiresAt;
  if (!looser) {
    await ctx.db.patch(agent._id, { scopes: next.scopes, perPaymentMinor: next.perPaymentMinor, dailyCapMinor: next.dailyCapMinor, expiresAt: next.expiresAt });
  } else {
    // Scopes other than limits are app-side permissions; they can change now.
    await ctx.db.patch(agent._id, { scopes: next.scopes });
  }
  return (await grantTask(ctx, user, agent, next)).token;
}
