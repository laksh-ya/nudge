import { v, ConvexError } from "convex/values";
import { formatMoney, isVaultVersion } from "@agent-wallet/domain";
import { internalMutation, internalQuery, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { own, requireViewer } from "./lib/auth";
import { computeOverview } from "./lib/overview";
import { newApprovalToken } from "./lib/seed";
import { sha256 } from "./lib/hash";
import { ownerPayTask, paymentIdFor } from "./lib/actions";
import { changeLimits, revokeAgent } from "./lib/control";
import { intentFor, paymentFor } from "./lib/mandates";
import { agentPool, laneOf } from "./lib/relayer";
import { tryHit } from "./lib/limits";
import { scopeMessage, toolsFor } from "./lib/mcp";

/**
 * The single path outside assistants (MCP) and chat channels use to touch money.
 * Plain code decides: pay now, ask the owner, or refuse with a reason. The model never decides.
 */

const DAY = 86_400_000;


function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return "aw_" + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Owner issues a token for one assistant. Shown once; only its hash is stored. */
export const issueToken = mutation({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const user = await requireViewer(ctx);
    const agent = await own(user, await ctx.db.get(agentId));
    if (agent.provider === "own") throw new ConvexError("Your own assistant doesn't need a token");
    const token = randomToken();
    await ctx.db.patch(agent._id, { tokenHash: await sha256(token), status: agent.status === "frozen" ? "frozen" : "active", connectedAt: Date.now() });
    await ctx.db.insert("activity", { userId: user._id, kind: "agent", title: `New access key for ${agent.name}`, detail: "Older keys stop working", tone: "neutral" });
    return token;
  },
});

/** Operator-only (CLI with a deploy key): issue an assistant key for an account, for demos and tests. */
export const issueTokenAsOperator = internalMutation({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const agent = await ctx.db.get(agentId);
    if (!agent || agent.provider === "own") throw new ConvexError("No such assistant");
    const token = randomToken();
    await ctx.db.patch(agent._id, { tokenHash: await sha256(token), connectedAt: Date.now() });
    await ctx.db.insert("activity", { userId: agent.userId, kind: "agent", title: `New access key for ${agent.name}`, detail: "Issued by the operator for a demo", tone: "neutral" });
    return token;
  },
});

export const updateGrant = mutation({
  args: {
    agentId: v.id("agents"),
    scopes: v.array(v.union(v.literal("read"), v.literal("prepare"), v.literal("spend"), v.literal("request"))),
    dailyCapMinor: v.number(),
    perPaymentMinor: v.number(),
    hidesBalances: v.boolean(),
    days: v.number(),
  },
  handler: async (ctx, args) => {
    const user = await requireViewer(ctx);
    const agent = await own(user, await ctx.db.get(args.agentId));
    for (const n of [args.dailyCapMinor, args.perPaymentMinor]) if (!Number.isSafeInteger(n) || n < 0 || n > 1e9) throw new ConvexError("Limit is out of range");
    if (args.perPaymentMinor > args.dailyCapMinor) throw new ConvexError("A single payment can't exceed the daily limit");
    if (!Number.isInteger(args.days) || args.days < 1 || args.days > 365) throw new ConvexError("Pick 1 to 365 days");
    const scopes = [...new Set(args.scopes)];
    if (!scopes.includes("read")) scopes.unshift("read");
    await ctx.db.patch(agent._id, { hidesBalances: args.hidesBalances });
    const approvalToken = await changeLimits(ctx, user, agent, {
      scopes,
      perPaymentMinor: args.perPaymentMinor,
      dailyCapMinor: args.dailyCapMinor,
      expiresAt: Date.now() + args.days * DAY,
    });
    await ctx.db.insert("activity", {
      userId: user._id,
      kind: "agent",
      title: `Changed what ${agent.name} may do`,
      detail: !scopes.includes("spend") ? "Can't spend" : approvalToken ? "Waiting for your passkey" : `Up to $${(args.dailyCapMinor / 100).toFixed(2)} a day`,
      tone: "neutral",
    });
    return approvalToken;
  },
});

export const revoke = mutation({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const user = await requireViewer(ctx);
    const agent = await own(user, await ctx.db.get(agentId));
    if (agent.provider === "own") throw new ConvexError("Freeze your own assistant instead");
    return await revokeAgent(ctx, user, agent);
  },
});

/** 60 calls a minute per assistant, counting every call in a batch. */
export const allow = internalMutation({
  args: { agentId: v.id("agents"), calls: v.optional(v.number()) },
  handler: async (ctx, { agentId, calls = 1 }) => {
    for (let i = 0; i < Math.max(1, calls); i++) {
      if (!(await tryHit(ctx, `mcp:${agentId}`, 60, 60_000))) return false;
    }
    return true;
  },
});

export const agentByToken = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const agent = await ctx.db.query("agents").withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash)).unique();
    if (!agent) return null;
    return { _id: agent._id, name: agent.name, status: agent.status, expiresAt: agent.expiresAt, scopes: agent.scopes };
  },
});

type Agent = Doc<"agents">;

async function load(ctx: QueryCtx, agentId: Id<"agents">) {
  const agent = await ctx.db.get(agentId);
  if (!agent) throw new ConvexError("Unknown assistant");
  if (agent.status === "revoked") throw new ConvexError(`${agent.name} was disconnected by its owner. The owner can reconnect it from the Agents screen with a new key.`);
  if (agent.status === "frozen") throw new ConvexError(`${agent.name} is frozen by its owner. Nothing can be read or paid until the owner unfreezes it on the Agents screen.`);
  if (agent.expiresAt < Date.now()) throw new ConvexError(`${agent.name}'s access has expired. Ask the owner to extend it in Agents → ${agent.name} → Limits.`);
  const user = (await ctx.db.get(agent.userId))!;
  return { agent, user };
}

/** Refuses in words a model can pass on: what this assistant can't do and where the owner allows it. */
function need(agent: Agent, scope: Agent["scopes"][number]) {
  if (!agent.scopes.includes(scope)) throw new ConvexError(scopeMessage(agent.name, scope, agent.scopes));
}

/**
 * What this assistant may do right now, in dollars, so a model can plan before it asks and explain
 * a refusal. On a live vault the vault's own numbers win where they're stricter.
 */
export const myLimits = internalQuery({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const { agent, user } = await load(ctx, agentId);
    const usd = (minor: number) => ({ amountMinor: minor, currency: "USD", display: formatMoney(minor, "USDC") });
    const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    const live = Boolean(wallet && wallet.status === "live" && isVaultVersion(wallet.version));
    const agentVault = live && agent.vault?.active ? agent.vault : undefined;
    const spend = agent.scopes.includes("spend");
    const perPayment = spend ? Math.min(agent.perPaymentMinor, agentVault?.perPaymentMinor ?? Infinity) : 0;
    const dailyCap = spend ? Math.min(agent.dailyCapMinor, agentVault?.dailyCapMinor ?? Infinity) : 0;
    const can = (s: Agent["scopes"][number]) => agent.scopes.includes(s);
    return {
      assistant: agent.name,
      permissions: agent.scopes,
      canSeeMoney: can("read"),
      canProposePayments: can("prepare"),
      canPayWithinLimits: spend,
      canAskOwnerForMore: can("request"),
      perPaymentLimit: usd(perPayment),
      dailyLimit: usd(dailyCap),
      leftToday: usd(Math.max(0, dailyCap - agent.spentTodayMinor)),
      balancesHidden: agent.hidesBalances,
      walletFrozen: Boolean(wallet?.frozen || wallet?.vault?.frozen),
      enforcedOnChain: live,
      accessExpiresAt: new Date(agent.expiresAt).toISOString(),
      tools: toolsFor(agent.scopes).map((t) => t.name),
      note: !can("prepare")
        ? scopeMessage(agent.name, "prepare", agent.scopes)
        : !spend
          ? `Every payment you propose goes to the owner to approve. To pay small amounts without asking, the owner can turn on "Pay within limits" in Agents → ${agent.name} → Limits.`
          : `Payments up to ${formatMoney(perPayment, "USDC")} each and ${formatMoney(dailyCap, "USDC")} a day go through on their own; anything more${can("request") ? " goes to the owner to approve" : " is refused"}.`,
    };
  },
});

export const overview = internalQuery({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const { agent, user } = await load(ctx, agentId);
    need(agent, "read");
    const o = await computeOverview(ctx, user);
    const bills = o.upcoming.slice(0, 5).map((b) => ({ name: b.name, amount: formatMoney(b.amountMinor, b.currency), due: new Date(b.nextDueAt).toISOString().slice(0, 10) }));
    const allowance = Math.max(0, agent.dailyCapMinor - agent.spentTodayMinor);
    if (agent.hidesBalances) {
      return {
        owner: user.name,
        balances: "hidden by the owner",
        daysToPayday: o.daysToIncome,
        upcomingBills: bills,
        yourAllowanceToday: formatMoney(Math.min(allowance, o.agentAuthority), "USDC"),
      };
    }
    return {
      owner: user.name,
      safeToSpend: formatMoney(o.available, o.currency),
      perDayUntilPayday: formatMoney(o.perDay, o.currency),
      daysToPayday: o.daysToIncome,
      spentThisMonth: formatMoney(o.spentThisMonth, o.currency),
      monthlyBudget: o.budget ? formatMoney(o.budget, o.currency) : null,
      upcomingBills: bills,
      yourAllowanceToday: formatMoney(Math.min(allowance, o.agentAuthority), "USDC"),
    };
  },
});

export const canAfford = internalQuery({
  args: { agentId: v.id("agents"), amount: v.number() },
  handler: async (ctx, { agentId, amount }) => {
    const { agent, user } = await load(ctx, agentId);
    need(agent, "read");
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e9) throw new ConvexError("Amount must be a positive number");
    // A yes/no about any amount would let an assistant find a hidden balance by halving guesses.
    if (agent.hidesBalances) {
      return { hidden: true, note: "The owner keeps balances private from this assistant. Propose the payment; the wallet's limits decide." };
    }
    const o = await computeOverview(ctx, user);
    const minor = Math.round(amount * 100);
    const ok = minor <= o.available;
    return {
      affordable: ok,
      currency: o.currency,
      note: ok ? "Fits after bills, the emergency fund and pending payments." : "That would dip into money set aside for bills or emergencies.",
      safeToSpend: formatMoney(o.available, o.currency),
    };
  },
});

export const bills = internalQuery({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const { agent, user } = await load(ctx, agentId);
    need(agent, "read");
    const list = await ctx.db.query("obligations").withIndex("by_user_due", (q) => q.eq("userId", user._id)).take(100);
    return list
      .filter((b) => b.status === "active")
      .map((b) => ({ name: b.name, kind: b.kind, amount: formatMoney(b.amountMinor, b.currency), cadence: b.cadence, nextDue: new Date(b.nextDueAt).toISOString().slice(0, 10) }));
  },
});

export const spending = internalQuery({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const { agent, user } = await load(ctx, agentId);
    need(agent, "read");
    const o = await computeOverview(ctx, user);
    return {
      month: new Date().toISOString().slice(0, 7),
      byCategory: o.categories.map((c) => ({ category: c.name, ...(agent.hidesBalances ? {} : { amount: formatMoney(c.amount, o.currency) }) })),
      ...(agent.hidesBalances ? {} : { total: formatMoney(o.spentThisMonth, o.currency) }),
    };
  },
});

export const contacts = internalQuery({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const { agent, user } = await load(ctx, agentId);
    need(agent, "read");
    const payees = await ctx.db.query("payees").withIndex("by_user", (q) => q.eq("userId", user._id)).take(200);
    // Ids and names only. Addresses never leave the wallet.
    return payees.map((p) => ({ contactId: p._id, name: p.name, kind: p.kind, newContact: !p.trusted }));
  },
});

/**
 * A notice on the owner's own chat, which the calling agent can't write to or bury. Fixed wording:
 * the agent's reason is never forwarded. Does nothing when no chat is linked.
 */
async function notify(ctx: MutationCtx, userId: Id<"users">, text: string, approvalUrl?: string) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  await ctx.scheduler.runAfter(0, internal.telegram.send, { userId, text, approvalUrl });
}

/** Agent payments sent (or being sent) to the vault whose receipt hasn't been counted yet. */
async function paymentsInFlight(ctx: QueryCtx, userId: Id<"users">) {
  const states = ["reserved", "submitted", "unknown"] as const;
  const rows = await Promise.all(
    states.map((state) => ctx.db.query("tasks").withIndex("by_user_state", (q) => q.eq("userId", userId).eq("state", state)).take(100)),
  );
  return rows.flat().filter((t) => t.rail === "base-sepolia" && t.agentId && t.action === undefined);
}

/** What agents sent this contact in the last 24 hours, counting payments still on their way. */
async function agentPaidTo(ctx: QueryCtx, payeeId: Id<"payees">) {
  const counted = new Set(["reserved", "submitted", "unknown", "held", "confirmed"]);
  const recent = await ctx.db
    .query("tasks")
    .withIndex("by_payee", (q) => q.eq("payeeId", payeeId).gt("_creationTime", Date.now() - 24 * 3600_000))
    .take(500);
  return recent.filter((t) => t.agentId && t.action === undefined && t.rail !== "handoff" && counted.has(t.state)).reduce((s, t) => s + (t.amountMinor ?? 0), 0);
}

type Decision =
  /** Accepted and on its way; not paid until get_task_status says confirmed. */
  | { outcome: "submitted"; taskId: Id<"tasks">; message: string }
  | { outcome: "duplicate"; taskId: Id<"tasks">; state: string; message: string }
  // No link: the approval capability goes only to the owner (dashboard, Telegram), never to the agent.
  | { outcome: "needs_approval"; taskId: Id<"tasks">; reason: string; message: string }
  | { outcome: "refused"; code: string; reason: string };

async function recordNote(ctx: MutationCtx, user: Doc<"users">, agent: Agent, text: string, taskId?: Id<"tasks">) {
  await ctx.db.insert("messages", { userId: user._id, role: "assistant", text, channel: "mcp", taskId });
}

export type Proposal = { agentId: Id<"agents">; contactId: string; amount: number; reason: string; requestId?: string };

/** The payment decision every assistant gets, outside assistants over MCP and the owner's own in chat. */
export const proposePayment = internalMutation({
  args: { agentId: v.id("agents"), contactId: v.string(), amount: v.number(), reason: v.string(), requestId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Decision> => await propose(ctx, args),
});

/**
 * Pay inside the limits, ask the owner, or refuse. `quiet` skips the chat note for callers that
 * reply in the conversation themselves.
 */
export async function propose(ctx: MutationCtx, { agentId, contactId, amount, reason, requestId }: Proposal, opts: { quiet?: boolean; channel?: "mcp" | "app" | "telegram" } = {}): Promise<Decision> {
    const record = opts.quiet ? async () => {} : recordNote;
    const channel = opts.channel ?? "mcp";
    const { agent, user } = await load(ctx, agentId);
    need(agent, "prepare");
    await ctx.db.patch(agent._id, { lastUsedAt: Date.now() });
    if (requestId !== undefined && !/^[\w.:#/-]{1,80}$/.test(requestId)) return { outcome: "refused", code: "2011", reason: "requestId must be 1 to 80 letters, digits or .:#/-_" };
    if (requestId) {
      // The same request again (a retry, a duplicate invoice): report the first one, never pay twice.
      // Scoped to the wallet, not the agent: one invoice forwarded to two assistants is paid once.
      const earlier = await ctx.db.query("tasks").withIndex("by_user_request", (q) => q.eq("userId", user._id).eq("requestId", requestId)).first();
      if (earlier) {
        // The same id must mean the same payment; anything else is a conflict, not a duplicate.
        const samePayee = earlier.payeeId === ctx.db.normalizeId("payees", contactId);
        if (!samePayee || earlier.amountMinor !== Math.round(amount * 100)) {
          return { outcome: "refused", code: "2013", reason: "This requestId was already used for a different payment (another contact or amount). Use a new requestId." };
        }
        // Only an assistant handed this task as a duplicate may read its status.
        if (earlier.agentId !== agent._id && !(earlier.sharedWith ?? []).includes(agent._id)) {
          await ctx.db.patch(earlier._id, { sharedWith: [...(earlier.sharedWith ?? []), agent._id].slice(-10) });
        }
        return { outcome: "duplicate", taskId: earlier._id, state: earlier.state, message: "A payment with this requestId already exists. Check get_task_status instead of retrying." };
      }
    }
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e6) return { outcome: "refused", code: "2003", reason: "Amount must be a positive number of dollars" };
    const minor = Math.round(amount * 100);
    // $0.004 would round to nothing, pass every check and then be refused on-chain as a strike.
    if (minor < 1 || Math.abs(amount * 100 - minor) > 1e-6) return { outcome: "refused", code: "2003", reason: "Amounts are whole cents, at least $0.01" };
    const payeeId = ctx.db.normalizeId("payees", contactId);
    const payee = payeeId ? await ctx.db.get(payeeId) : null;
    if (!payee || payee.userId !== user._id) {
      await ctx.db.insert("activity", { userId: user._id, kind: "agent", title: `${agent.name} tried an unknown payee`, detail: "Refused: not in your contacts", tone: "bad" });
      return { outcome: "refused", code: "2010", reason: "Unknown contact. Payments can only go to the owner's saved contacts; use list_contacts." };
    }
    // A contact the owner just added isn't payable by agents until the vault has it and its waiting period ends.
    if (payee.pendingPasskey || (payee.activeAt && payee.activeAt > Date.now())) {
      const when = payee.pendingPasskey ? "the owner approves it with their passkey" : `${new Date(payee.activeAt!).toISOString().slice(0, 16).replace("T", " ")} UTC`;
      await ctx.db.insert("activity", { userId: user._id, kind: "agent", title: `${agent.name} tried to pay ${payee.name} too early`, detail: `Refused: a new contact, active after ${when}`, tone: "warn" });
      return { outcome: "refused", code: "2002", reason: `${payee.name} is a new contact. Agents can pay it after ${when}.` };
    }
    const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    if (!wallet) return { outcome: "refused", code: "2001", reason: "The owner hasn't set up a Nudge wallet" };
    const purpose = reason.trim().slice(0, 140) || undefined;

    // When the vault is live its own numbers win; our copy can only be stricter, never looser.
    const vault = wallet.status === "live" && isVaultVersion(wallet.version) ? wallet.vault : undefined;
    // Before the vault registers this agent its record reads as zeros; those aren't limits yet.
    const agentVault = vault && agent.vault?.active ? agent.vault : undefined;
    const perPayment = Math.min(agent.perPaymentMinor, agentVault?.perPaymentMinor ?? Infinity);
    const dailyCap = Math.min(agent.dailyCapMinor, agentVault?.dailyCapMinor ?? Infinity);
    const agents = await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50);
    // Payments already on their way to the vault count now, before any receipt. Reading them here
    // makes simultaneous requests conflict and run one after another, so a burst can't all pass.
    const inFlight = vault ? await paymentsInFlight(ctx, user._id) : [];
    const pendingAll = inFlight.reduce((s, t) => s + (t.amountMinor ?? 0), 0);
    const pendingAgent = inFlight.filter((t) => t.agentId === agent._id).reduce((s, t) => s + (t.amountMinor ?? 0), 0);
    const agentSpent = agent.spentTodayMinor + pendingAgent;
    const spentToday = (vault ? vault.spentMinor : agents.reduce((s, a) => s + a.spentTodayMinor, 0)) + pendingAll;
    const ceiling = Math.min(wallet.dailyCeilingMinor, vault?.ceilingMinor ?? Infinity);
    const protectedMinor = Math.max(wallet.protectedMinor, vault?.protectedMinor ?? 0);
    const free = (vault ? vault.balanceMinor - vault.heldMinor : wallet.balanceMinor) - pendingAll;
    const blockers: { code: string; why: string }[] = [];
    if (wallet.frozen || vault?.frozen) blockers.push({ code: "1002", why: "The wallet is frozen" });
    if (!agent.scopes.includes("spend")) blockers.push({ code: "2002", why: `${agent.name} can prepare payments but not send them` });
    if (minor > perPayment) blockers.push({ code: "2003", why: `Above ${agent.name}'s ${formatMoney(perPayment, "USDC")} per-payment limit` });
    if (agentSpent + minor > dailyCap) blockers.push({ code: "2003", why: `Above ${agent.name}'s daily limit` });
    if (spentToday + minor > ceiling) blockers.push({ code: "2004", why: "Above the wallet's daily ceiling for all agents" });
    if (free - minor < protectedMinor) blockers.push({ code: "2005", why: "Would dip into the protected amount" });
    if (!payee.trusted || (payee.holdUntil && payee.holdUntil > Date.now())) blockers.push({ code: "2006", why: `${payee.name} is a new contact` });
    if (payee.dailyCapMinor) {
      const toPayee = await agentPaidTo(ctx, payee._id);
      if (toPayee + minor > payee.dailyCapMinor) blockers.push({ code: "2012", why: `Above ${payee.name}'s ${formatMoney(payee.dailyCapMinor, "USDC")} daily limit for all agents` });
    }

    if (free < minor) return { outcome: "refused", code: "2005", reason: "Not enough in the wallet" };

    const live = wallet.status === "live" && isVaultVersion(wallet.version);
    if (blockers.length === 0 && live && agent.onchain && payee.onchain) {
      // The vault decides. Our checks passed; the contract checks again with the agent's own key.
      const taskId = await ctx.db.insert("tasks", {
        userId: user._id,
        title: purpose ?? `Pay ${payee.name}`,
        channel,
        agentId: agent._id,
        payeeId: payee._id,
        amountMinor: minor,
        currency: "USDC",
        purpose,
        state: "reserved",
        rail: "base-sepolia",
        requestId,
        updatedAt: Date.now(),
      });
      await ctx.db.patch(taskId, { paymentId: paymentIdFor(taskId, agent._id, requestId) });
      await agentPool.enqueueAction(ctx, internal.chain.agentPay, { taskId, lane: laneOf(user._id) });
      await record(ctx, user, agent, `${agent.name} is paying ${payee.name} ${formatMoney(minor, "USDC")} within its limits.`, taskId);
      const held = vault && vault.holdFor > 0 && minor > vault.holdAboveMinor;
      return {
        outcome: "submitted",
        taskId,
        message: held
          ? `Paying ${payee.name} ${formatMoney(minor, "USDC")} on Base Sepolia. Above ${formatMoney(vault.holdAboveMinor, "USDC")}, so the vault holds it ${Math.round(vault.holdFor / 60)} min for the owner to cancel. Check get_task_status.`
          : `Sending ${formatMoney(minor, "USDC")} to ${payee.name} on Base Sepolia. Check get_task_status for the transaction.`,
      };
    }
    if (blockers.length === 0 && live) blockers.push({ code: "1001", why: `${agent.name} isn't registered in the vault yet` });

    if (blockers.length === 0) {
      const taskId = await ctx.db.insert("tasks", {
        userId: user._id,
        title: purpose ?? `Pay ${payee.name}`,
        channel,
        agentId: agent._id,
        payeeId: payee._id,
        amountMinor: minor,
        currency: "USDC",
        purpose,
        state: "submitted",
        rail: "simulator",
        requestId,
        updatedAt: Date.now(),
      });
      await ctx.db.patch(agent._id, { spentTodayMinor: agent.spentTodayMinor + minor });
      await ctx.scheduler.runAfter(1200, internal.tasks.settle, { taskId });
      await record(ctx, user, agent, `${agent.name} is paying ${payee.name} ${formatMoney(minor, "USDC")} within its limits.`, taskId);
      return { outcome: "submitted", taskId, message: `Paying ${payee.name} ${formatMoney(minor, "USDC")}. Check get_task_status for confirmation.` };
    }

    const hard = blockers.find((b) => b.code === "1002");
    if (hard || !agent.scopes.includes("request") && agent.scopes.includes("spend")) {
      const b = hard ?? blockers[0]!;
      await ctx.db.insert("activity", { userId: user._id, kind: "agent", title: `Refused ${agent.name}: ${b.why}`, tone: "warn" });
      if (agent.provider !== "own") await notify(ctx, user._id, `Refused: ${agent.name} tried to pay ${payee.name} ${formatMoney(minor, "USDC")}. ${b.why}.`);
      return { outcome: "refused", code: b.code, reason: b.why };
    }

    if (live) {
      const { taskId, token } = await ownerPayTask(ctx, {
        user,
        payee,
        amountMinor: minor,
        title: purpose ?? `Pay ${payee.name}`,
        channel,
        agentId: agent._id,
        purpose,
        reason: blockers.map((b) => b.why).join(". "),
        requestId,
      });
      await record(ctx, user, agent, `${agent.name} asked to pay ${payee.name} ${formatMoney(minor, "USDC")}. ${blockers[0]!.why}, so it needs your passkey.`, taskId);
      const base = process.env.APPROVE_URL ?? "https://agent-wallet-approve.vercel.app";
      if (agent.provider !== "own") {
        await notify(ctx, user._id, `${agent.name} asks to pay ${payee.name} ${formatMoney(minor, "USDC")}. ${blockers[0]!.why}, so it needs your passkey.`, `${base}/a/${token}`);
      }
      return { outcome: "needs_approval", taskId, reason: blockers.map((b) => b.why).join(". "), message: "Sent to the owner to approve with their passkey. They have been notified; check get_task_status." };
    }

    const token = newApprovalToken();
    const taskId = await ctx.db.insert("tasks", {
      userId: user._id,
      title: purpose ?? `Pay ${payee.name}`,
      channel,
      agentId: agent._id,
      payeeId: payee._id,
      amountMinor: minor,
      currency: "USDC",
      purpose,
      state: "awaiting_approval",
      reason: blockers.map((b) => b.why).join(". "),
      rail: "simulator",
      requestId,
      approvalToken: token,
      expiresAt: Date.now() + 30 * 60_000,
      updatedAt: Date.now(),
    });
    await record(ctx, user, agent, `${agent.name} asked to pay ${payee.name} ${formatMoney(minor, "USDC")}. ${blockers[0]!.why}, so it needs you.`, taskId);
    const base = process.env.APPROVE_URL ?? "https://agent-wallet-approve.vercel.app";
    if (agent.provider !== "own") {
      await notify(ctx, user._id, `${agent.name} asks to pay ${payee.name} ${formatMoney(minor, "USDC")}. ${blockers[0]!.why}, so it needs you.`, `${base}/a/${token}`);
    }
    return { outcome: "needs_approval", taskId, reason: blockers.map((b) => b.why).join(". "), message: "Sent to the owner to approve with their passkey. They have been notified; check get_task_status." };
  }

/**
 * The AP2 IntentMandate this assistant acts under: what the owner allowed, signed with their passkey
 * and enforced by the vault. An assistant can show it to a merchant's agent, which can check every
 * claim on Base Sepolia (packages/domain/src/mandates.ts, verifyIntent) without asking us.
 */
export const mandate = internalQuery({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const { agent } = await load(ctx, agentId);
    const m = await intentFor(ctx, agent);
    return m ?? { mandate: null, reason: "Your limits aren't in the owner's vault yet (a simulated wallet, or the owner hasn't approved them)." };
  },
});

export const taskStatus = internalQuery({
  args: { agentId: v.id("agents"), taskId: v.string() },
  handler: async (ctx, { agentId, taskId }) => {
    const { agent, user } = await load(ctx, agentId);
    const id = ctx.db.normalizeId("tasks", taskId);
    const task = id ? await ctx.db.get(id) : null;
    // Another assistant's task is visible only when it was handed back as a duplicate of the same invoice.
    const shared = Boolean(task?.sharedWith?.includes(agent._id));
    if (!task || task.userId !== user._id || (task.agentId !== agent._id && !shared)) throw new ConvexError("No such task for this assistant");
    // Settled on-chain: the AP2 PaymentMandate for it, under this assistant's intent mandate.
    const intent = task.state === "confirmed" && task.agentId === agent._id ? await intentFor(ctx, agent) : null;
    const payment_mandate = intent ? await paymentFor(ctx, task, agent, intent) : null;
    return {
      taskId: task._id,
      state: task.state,
      amount: task.amountMinor !== undefined ? formatMoney(task.amountMinor, task.currency ?? "USDC") : null,
      reason: task.reason ?? null,
      simulated: task.rail === "simulator",
      transaction: task.txHash ? `https://sepolia.basescan.org/tx/${task.txHash}` : null,
      releasesAt: task.state === "held" && task.releaseAt ? new Date(task.releaseAt).toISOString() : null,
      updatedAt: new Date(task.updatedAt).toISOString(),
      ...(payment_mandate ? { payment_mandate } : {}),
    };
  },
});

export const cancelTask = internalMutation({
  args: { agentId: v.id("agents"), taskId: v.string() },
  handler: async (ctx, { agentId, taskId }) => {
    const { agent, user } = await load(ctx, agentId);
    const id = ctx.db.normalizeId("tasks", taskId);
    const task = id ? await ctx.db.get(id) : null;
    if (!task || task.userId !== user._id || task.agentId !== agent._id) throw new ConvexError("No such task for this assistant");
    if (task.state !== "awaiting_approval" && task.state !== "drafted") return { cancelled: false, state: task.state };
    await ctx.db.patch(task._id, { state: "cancelled", approvalToken: undefined, updatedAt: Date.now() });
    return { cancelled: true, state: "cancelled" };
  },
});
