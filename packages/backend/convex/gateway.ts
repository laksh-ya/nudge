import { v, ConvexError } from "convex/values";
import { Op, formatMoney, isVaultVersion } from "@agent-wallet/domain";
import { internalMutation, internalQuery, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { own, requireViewer } from "./lib/auth";
import { computeOverview } from "./lib/overview";
import { newApprovalToken } from "./lib/seed";
import { sha256 } from "./lib/hash";
import { durationText, openTwin, ownerPayTask, paymentIdFor, whenText } from "./lib/actions";
import { changeLimits, revokeAgent } from "./lib/control";
import { intentFor, paymentFor } from "./lib/mandates";
import { agentPool, laneOf } from "./lib/relayer";
import { tryHit } from "./lib/limits";
import { toolsFor } from "./lib/mcp";
import { purchaseView } from "./lib/commerce";
import { approveLink } from "./lib/links";
import { getAddress, isAddress, zeroAddress } from "viem";

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
    /** Only these contacts may be paid without asking; an empty list means any trusted contact. */
    allowedPayees: v.optional(v.array(v.id("payees"))),
  },
  handler: async (ctx, args) => {
    const user = await requireViewer(ctx);
    const agent = await own(user, await ctx.db.get(args.agentId));
    for (const n of [args.dailyCapMinor, args.perPaymentMinor]) if (!Number.isSafeInteger(n) || n < 0 || n > 1e9) throw new ConvexError("Limit is out of range");
    if (args.perPaymentMinor > args.dailyCapMinor) throw new ConvexError("A single payment can't exceed the daily limit");
    if (!Number.isInteger(args.days) || args.days < 1 || args.days > 365) throw new ConvexError("Pick 1 to 365 days");
    const scopes = [...new Set(args.scopes)];
    if (!scopes.includes("read")) scopes.unshift("read");
    for (const id of args.allowedPayees ?? []) await own(user, await ctx.db.get(id));
    // Narrowing who it may pay only tightens, so it applies at once (the vault still checks its own limits).
    await ctx.db.patch(agent._id, { hidesBalances: args.hidesBalances, ...(args.allowedPayees ? { allowedPayees: args.allowedPayees.length ? [...new Set(args.allowedPayees)].slice(0, 50) : undefined } : {}) });
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

export async function load(ctx: QueryCtx, agentId: Id<"agents">) {
  const agent = await ctx.db.get(agentId);
  if (!agent) throw new ConvexError("Unknown assistant");
  if (agent.status === "revoked") throw new ConvexError(`${agent.name} was disconnected by its owner. The owner can reconnect it from the Agents screen with a new key.`);
  if (agent.status === "frozen") throw new ConvexError(`${agent.name} is frozen by its owner. Nothing can be read or paid until the owner unfreezes it on the Agents screen.`);
  if (agent.expiresAt < Date.now()) throw new ConvexError(`${agent.name}'s access has expired. Ask the owner to extend it in Agents → ${agent.name} → Limits.`);
  const user = (await ctx.db.get(agent.userId))!;
  return { agent, user };
}

/**
 * Every connected assistant may read and ask; what it may do on its own is set by its limits.
 * Kept as the one place a per-tool permission would go.
 */
function need(_agent: Agent, _scope: Agent["scopes"][number]) {}

/** The approval page for a token. Handed to the owner and, since 18 Oct, to the asking assistant too: the link only shows the request; approving needs the owner's passkey (or their signed-in session on a simulated wallet). */
export function approveUrl(token: string) {
  return approveLink(token);
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
    const holdAbove = live && wallet?.vault ? wallet.vault.holdAboveMinor : null;
    return {
      assistant: agent.name,
      owner: user.name,
      payOnYourOwn: spend && perPayment > 0,
      perPaymentLimit: usd(perPayment),
      dailyLimit: usd(dailyCap),
      // Includes payments it asked for that the owner approved (#105), as the gateway counts them.
      leftToday: usd(Math.max(0, dailyCap - agent.spentTodayMinor - (agent.provider === "own" ? 0 : await approvedForAgent(ctx, user._id, agent._id)))),
      holdAbove: holdAbove === null ? null : usd(holdAbove),
      balancesHidden: agent.hidesBalances,
      walletFrozen: Boolean(wallet?.frozen || wallet?.vault?.frozen),
      walletOnChain: live,
      accessExpiresAt: new Date(agent.expiresAt).toISOString(),
      // On a live vault the grant has its own expiry, set when the owner signed it (#104). Paying alone
      // stops at the earlier of the two; say which.
      ...(live && agent.vault?.active
        ? {
            vaultGrantExpiresAt: new Date(agent.vault.expiresAt).toISOString(),
            payAloneUntil: new Date(Math.min(agent.expiresAt, agent.vault.expiresAt)).toISOString(),
          }
        : {}),
      tools: toolsFor().map((t) => t.name),
      note:
        spend && perPayment > 0
          ? `You may pay up to ${formatMoney(perPayment, "USDC")} a payment and ${formatMoney(dailyCap, "USDC")} a day on your own. Anything more, or to a new recipient, returns an approval link for ${user.name || "the user"} to approve with their passkey. Use request_limits to ask for more room.`
          : `Every payment you make returns an approval link for ${user.name || "the user"} to approve with their passkey. To pay small amounts without asking, use request_limits (or the user sets limits in Agents → ${agent.name}).`,
    };
  },
});

export const overview = internalQuery({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const { agent, user } = await load(ctx, agentId);
    need(agent, "read");
    const o = await computeOverview(ctx, user);
    // One currency per group, never summed across (#97): bills by their own currency, the owner's
    // money in their home currency, and the Nudge wallet in test dollars on its own.
    const billsByCurrency: Record<string, { name: string; amount: string; due: string }[]> = {};
    for (const b of o.upcoming.slice(0, 5)) {
      (billsByCurrency[b.currency] ??= []).push({ name: b.name, amount: formatMoney(b.amountMinor, b.currency), due: new Date(b.nextDueAt).toISOString().slice(0, 10) });
    }
    const allowance = Math.max(0, agent.dailyCapMinor - agent.spentTodayMinor);
    const yourAllowanceToday = `${formatMoney(Math.min(allowance, o.agentAuthority), "USDC")} (test dollars, from the Nudge wallet)`;
    if (agent.hidesBalances) {
      return {
        owner: user.name,
        balances: "hidden by the owner",
        daysToPayday: o.daysToIncome,
        upcomingBillsByCurrency: billsByCurrency,
        yourAllowanceToday,
      };
    }
    const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    const walletMinor = wallet ? (wallet.status === "live" && wallet.vault ? wallet.vault.balanceMinor - wallet.vault.heldMinor : wallet.balanceMinor) : null;
    return {
      owner: user.name,
      homeCurrency: o.currency,
      inHomeCurrency: {
        note: `Everything here is in ${o.currency}${o.ratesDate ? `, other currencies converted at ${o.ratesDate} rates` : ""}${o.unconverted.length ? `; ${o.unconverted.join(", ")} left out (no rate)` : ""}.`,
        safeToSpend: formatMoney(o.available, o.currency),
        perDayUntilPayday: formatMoney(o.perDay, o.currency),
        spentThisMonth: formatMoney(o.spentThisMonth, o.currency),
        monthlyBudget: o.budget ? formatMoney(o.budget, o.currency) : null,
      },
      daysToPayday: o.daysToIncome,
      nudgeWallet:
        walletMinor === null
          ? "not set up"
          : `${formatMoney(walletMinor, "USDC")} (test dollars${wallet?.status === "live" ? " on Base Sepolia" : ", simulated"}; separate from the ${o.currency} money above, never add them)`,
      upcomingBillsByCurrency: billsByCurrency,
      yourAllowanceToday,
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
    // Ids and names only. Addresses never leave the wallet. Each says where it stands (#92): a new
    // payee needs the owner for every payment; a saved one may still be in the vault's wait.
    const now = Date.now();
    return payees.map((p) => {
      const until = Math.max(p.activeAt ?? 0, p.holdUntil ?? 0);
      const status = p.pendingPasskey || !p.trusted ? "new" : until > now ? "waiting" : "trusted";
      return {
        contactId: p._id,
        name: p.name,
        kind: p.kind,
        trusted: status === "trusted",
        status,
        ...(status === "waiting" ? { activeAt: new Date(until).toISOString() } : {}),
        canPayAlone:
          status === "trusted"
            ? "yes, within your limits"
            : status === "waiting"
              ? `from ${new Date(until).toISOString()}; until then the owner approves each payment`
              : "no: the owner approves each payment with the passkey (or makes it a trusted contact)",
      };
    });
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

const COUNTED = new Set(["reserved", "submitted", "unknown", "queued", "held", "confirmed"]);

/** An assistant asked for it and the owner approved it with the passkey (or, simulated, in the app). */
const ownerApproved = (t: Doc<"tasks">) => Boolean(t.approvedByOwner || t.action?.op === Op.Pay);

/**
 * What agents sent this contact in the last 24 hours, counting payments still on their way and
 * payments an agent asked for that the owner approved (#105). The owner's own assistant (chat)
 * is the owner, so its payments don't count against the assistants.
 */
async function agentPaidTo(ctx: QueryCtx, payeeId: Id<"payees">, ownAgents: Set<string>) {
  const recent = await ctx.db
    .query("tasks")
    .withIndex("by_payee", (q) => q.eq("payeeId", payeeId).gt("_creationTime", Date.now() - 24 * 3600_000))
    .take(500);
  return recent
    .filter((t) => t.agentId && !ownAgents.has(t.agentId) && t.rail !== "handoff" && COUNTED.has(t.state) && (t.action === undefined || ownerApproved(t)))
    .reduce((s, t) => s + (t.amountMinor ?? 0), 0);
}

/** Payments this agent asked for in the last 24 hours that the owner approved: the vault doesn't count them, we do (#105). */
export async function approvedForAgent(ctx: QueryCtx, userId: Id<"users">, agentId: Id<"agents">) {
  const since = Date.now() - 24 * 3600_000;
  const rows = await ctx.db.query("tasks").withIndex("by_user_updated", (q) => q.eq("userId", userId).gt("updatedAt", since)).take(300);
  return rows
    .filter((t) => t.agentId === agentId && t._creationTime > since && COUNTED.has(t.state) && ownerApproved(t))
    .reduce((s, t) => s + (t.amountMinor ?? 0), 0);
}

type Decision =
  /** Accepted and on its way; not paid until get_task_status says confirmed. */
  | { outcome: "submitted"; taskId: Id<"tasks">; message: string }
  | { outcome: "duplicate"; taskId: Id<"tasks">; state: string; message: string }
  // The link opens the request for the owner; approving needs their passkey (or their signed-in
  // session on a simulated wallet), so handing it to the assistant gives the assistant nothing.
  | { outcome: "needs_approval"; taskId: Id<"tasks">; reason: string; message: string; approvalUrl: string }
  | { outcome: "refused"; code: string; reason: string };

export type Decision_ = Decision;

async function recordNote(ctx: MutationCtx, user: Doc<"users">, agent: Agent, text: string, taskId?: Id<"tasks">) {
  await ctx.db.insert("messages", { userId: user._id, role: "assistant", text, channel: "mcp", taskId });
}

export type Proposal = { agentId: Id<"agents">; contactId?: string; toAddress?: string; name?: string; amount: number; reason: string; requestId?: string };

/** The payment decision every assistant gets, outside assistants over MCP and the owner's own in chat. */
export const proposePayment = internalMutation({
  args: {
    agentId: v.id("agents"),
    contactId: v.optional(v.string()),
    toAddress: v.optional(v.string()),
    name: v.optional(v.string()),
    amount: v.number(),
    reason: v.string(),
    requestId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Decision> => await propose(ctx, args),
});

/**
 * The payee for an address the assistant names: a saved contact with that address, or a new,
 * untrusted one. An untrusted payee is never paid without the owner's passkey.
 */
export async function payeeForAddress(ctx: MutationCtx, user: Doc<"users">, raw: string, name: string | undefined, kind: "person" | "merchant" = "person") {
  if (!isAddress(raw.trim(), { strict: false })) return null;
  const address = getAddress(raw.trim());
  if (address === zeroAddress) return null;
  const payees = await ctx.db.query("payees").withIndex("by_user", (q) => q.eq("userId", user._id)).take(200);
  const same = payees.find((p) => p.address?.toLowerCase() === address.toLowerCase());
  if (same) return same;
  const clean = (name ?? "").trim().replace(/\s+/g, " ").slice(0, 40) || `${address.slice(0, 6)}…${address.slice(-4)}`;
  const label = payees.some((p) => p.name.toLowerCase() === clean.toLowerCase()) ? `${clean} (${address.slice(-4)})` : clean;
  const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
  const id = await ctx.db.insert("payees", {
    userId: user._id,
    name: label,
    handle: `${address.slice(0, 6)}…${address.slice(-4)}`,
    kind,
    trusted: false,
    address,
    onchain: false,
    addedAt: Date.now(),
    ...(wallet?.status === "live" ? { pendingPasskey: true } : {}),
  });
  return (await ctx.db.get(id))!;
}

/**
 * Pay inside the limits, ask the owner, or refuse. `quiet` skips the chat note for callers that
 * reply in the conversation themselves.
 */
export async function propose(ctx: MutationCtx, { agentId, contactId, toAddress, name, amount, reason, requestId }: Proposal, opts: { quiet?: boolean; channel?: "mcp" | "app" | "telegram"; kind?: "person" | "merchant" } = {}): Promise<Decision> {
    const record = opts.quiet ? async () => {} : recordNote;
    const channel = opts.channel ?? "mcp";
    const { agent, user } = await load(ctx, agentId);
    need(agent, "prepare");
    await ctx.db.patch(agent._id, { lastUsedAt: Date.now() });
    if (!contactId && !toAddress) return { outcome: "refused", code: "2010", reason: "Say who to pay: a contactId from list_contacts, or toAddress (0x…) with name." };
    if (!contactId && toAddress) {
      if (!isAddress(toAddress.trim(), { strict: false })) return { outcome: "refused", code: "2014", reason: "toAddress isn't a valid Base Sepolia address (0x followed by 40 hex characters)." };
      const w = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
      if (w?.address && w.address.toLowerCase() === toAddress.trim().toLowerCase()) return { outcome: "refused", code: "2014", reason: "That's the user's own wallet." };
    }
    if (requestId !== undefined && !/^[\w.:#/-]{1,80}$/.test(requestId)) return { outcome: "refused", code: "2011", reason: "requestId must be 1 to 80 letters, digits or .:#/-_" };
    if (requestId) {
      // The same request again (a retry, a duplicate invoice): report the first one, never pay twice.
      // Scoped to the wallet, not the agent: one invoice forwarded to two assistants is paid once.
      const earlier = await ctx.db.query("tasks").withIndex("by_user_request", (q) => q.eq("userId", user._id).eq("requestId", requestId)).first();
      if (earlier) {
        // The same id must mean the same payment; anything else is a conflict, not a duplicate.
        const earlierPayee = earlier.payeeId ? await ctx.db.get(earlier.payeeId) : null;
        const samePayee = contactId
          ? earlier.payeeId === ctx.db.normalizeId("payees", contactId)
          : Boolean(toAddress && earlierPayee?.address?.toLowerCase() === toAddress.trim().toLowerCase());
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
    const payeeId = contactId ? ctx.db.normalizeId("payees", contactId) : null;
    const payee = contactId ? (payeeId ? await ctx.db.get(payeeId) : null) : await payeeForAddress(ctx, user, toAddress!, name, opts.kind);
    if (!payee || payee.userId !== user._id) {
      await ctx.db.insert("activity", { userId: user._id, kind: "agent", title: `${agent.name} tried an unknown contact id`, detail: "Refused: not in your contacts", tone: "warn" });
      return { outcome: "refused", code: "2010", reason: "Unknown contactId. Use list_contacts, or pay by toAddress with a name." };
    }
    // A contact the vault doesn't have yet (or whose waiting period hasn't ended) is paid by the
    // owner's passkey instead: the request goes to them rather than being refused.
    const notYet = Boolean(payee.pendingPasskey || (payee.activeAt && payee.activeAt > Date.now()));
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
    // Owner-approved payments it asked for count too (#105); only ever stricter than the vault.
    const approvedAgent = agent.provider === "own" ? 0 : await approvedForAgent(ctx, user._id, agent._id);
    const agentSpent = agent.spentTodayMinor + pendingAgent + approvedAgent;
    const spentToday = (vault ? vault.spentMinor : agents.reduce((s, a) => s + a.spentTodayMinor, 0)) + pendingAll;
    const ceiling = Math.min(wallet.dailyCeilingMinor, vault?.ceilingMinor ?? Infinity);
    const protectedMinor = Math.max(wallet.protectedMinor, vault?.protectedMinor ?? 0);
    const free = (vault ? vault.balanceMinor - vault.heldMinor : wallet.balanceMinor) - pendingAll;
    const blockers: { code: string; why: string }[] = [];
    if (wallet.frozen || vault?.frozen) blockers.push({ code: "1002", why: "The wallet is frozen" });
    if (!agent.scopes.includes("spend") || perPayment <= 0) blockers.push({ code: "2002", why: `${agent.name} asks you before every payment` });
    if (minor > perPayment) blockers.push({ code: "2003", why: `Above ${agent.name}'s ${formatMoney(perPayment, "USDC")} per-payment limit` });
    if (agentSpent + minor > dailyCap) blockers.push({ code: "2003", why: `Above ${agent.name}'s daily limit` });
    if (spentToday + minor > ceiling) blockers.push({ code: "2004", why: "Above the wallet's daily ceiling for all agents" });
    if (free - minor < protectedMinor) blockers.push({ code: "2005", why: "Would dip into the protected amount" });
    if (notYet || !payee.trusted || (payee.holdUntil && payee.holdUntil > Date.now())) {
      // Say which state it is in, with the vault's own numbers (#89, #92): new, or saved and waiting.
      const until = Math.max(payee.activeAt ?? 0, payee.holdUntil ?? 0);
      const why =
        until > Date.now() && !payee.pendingPasskey
          ? `${payee.name} is saved, but agents may pay it on their own only from ${whenText(until, user.timezone)} (your vault's ${durationText(wallet.vault?.contactDelay ?? wallet.rules?.contactDelay ?? 0)} wait for new contacts)`
          : `${payee.name} is a new payee, not a trusted contact`;
      blockers.push({ code: "2006", why });
      // Our copy may be behind the vault (an immediate re-add, an add made elsewhere): read it again (#101).
      if (wallet.status === "live" && wallet.vault && Date.now() - wallet.vault.syncedAt > 120_000) {
        await ctx.scheduler.runAfter(0, internal.chain.syncVault, { walletId: wallet._id });
      }
    }
    if (agent.allowedPayees?.length && !agent.allowedPayees.includes(payee._id)) blockers.push({ code: "2016", why: `${payee.name} isn't on ${agent.name}'s list of who it may pay alone` });
    if (payee.dailyCapMinor) {
      const toPayee = await agentPaidTo(ctx, payee._id, new Set(agents.filter((a) => a.provider === "own").map((a) => a._id as string)));
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

    // Only a freeze is a hard stop; everything else goes to the owner with an approval link.
    const hard = blockers.find((b) => b.code === "1002");
    if (hard) {
      const b = hard;
      await ctx.db.insert("activity", { userId: user._id, kind: "agent", title: `Refused ${agent.name}: ${b.why}`, tone: "warn" });
      if (agent.provider !== "own") await notify(ctx, user._id, `Refused: ${agent.name} tried to pay ${payee.name} ${formatMoney(minor, "USDC")}. ${b.why}.`);
      return { outcome: "refused", code: b.code, reason: b.why };
    }

    // Asked again while the first request still waits (a retry, a second tool call): the same link,
    // not a new one, and no second notification (#95).
    const twin = await openTwin(ctx, user._id, { agentId: agent._id, payeeId: payee._id, amountMinor: minor, requestId });
    if (twin) {
      return {
        outcome: "needs_approval",
        taskId: twin._id,
        approvalUrl: approveUrl(twin.approvalToken!),
        reason: twin.reason ?? blockers.map((b) => b.why).join(". "),
        message: `This payment is already waiting for ${user.name || "the user"}'s approval. Give them the same approvalUrl; don't ask again. Then check get_task_status.`,
      };
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
      if (agent.provider !== "own") {
        await notify(ctx, user._id, `${agent.name} asks to pay ${payee.name} ${formatMoney(minor, "USDC")}. ${blockers[0]!.why}, so it needs your passkey.`, approveUrl(token));
      }
      // Paying an address the vault hasn't saved waits the vault's change delay after the passkey;
      // say so, so the assistant doesn't promise an instant payment or invent a different wait (#89).
      const after = !payee.onchain && (wallet.vault?.changeDelay ?? 0) > 0 ? ` Once approved, the vault waits ${durationText(wallet.vault!.changeDelay)} before the money leaves (cancellable).` : "";
      return { outcome: "needs_approval", taskId, approvalUrl: approveUrl(token), reason: blockers.map((b) => b.why).join(". "), message: `Needs ${user.name || "the user"}'s passkey: ${blockers[0]!.why}. Give them the approvalUrl (one passkey pays it once); then check get_task_status.${after}` };
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
    if (agent.provider !== "own") {
      await notify(ctx, user._id, `${agent.name} asks to pay ${payee.name} ${formatMoney(minor, "USDC")}. ${blockers[0]!.why}, so it needs you.`, approveUrl(token));
    }
    return { outcome: "needs_approval", taskId, approvalUrl: approveUrl(token), reason: blockers.map((b) => b.why).join(". "), message: `Needs ${user.name || "the user"}'s approval: ${blockers[0]!.why}. Give them the approvalUrl; then check get_task_status.` };
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

/** What happens to a task next, in one sentence, so two reads a few seconds apart never look contradictory. */
function nextStep(t: Doc<"tasks">) {
  const at = (ms?: number) => (ms ? new Date(ms).toISOString() : "shortly");
  switch (t.state) {
    case "awaiting_approval":
      return "Waiting for the owner. Nothing is paid until they approve.";
    case "queued":
      return `Approved; the vault pays at ${at(t.readyAt)} unless the owner cancels. It then becomes confirmed.`;
    case "held":
      return `Paid into a hold; it leaves at ${at(t.releaseAt)} unless the owner cancels. It then becomes confirmed.`;
    case "reserved":
    case "submitted":
      return "On its way to the network; it becomes confirmed within a minute.";
    case "confirmed":
      return "Done. Nothing more will change.";
    default:
      return "Final. Nothing more will change.";
  }
}

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
      // One source (this task) and an explicit word on whether it can still change (#94): a queued
      // or held payment becomes confirmed on its own at readyAt / releasesAt unless cancelled.
      final: ["confirmed", "failed", "cancelled", "expired", "reported"].includes(task.state),
      ...(task.state === "queued" && task.readyAt ? { readyAt: new Date(task.readyAt).toISOString() } : {}),
      next: nextStep(task),
      updatedAt: new Date(task.updatedAt).toISOString(),
      ...(task.state === "awaiting_approval" && task.approvalToken ? { approvalUrl: approveUrl(task.approvalToken) } : {}),
      ...(task.purchase ? { purchase: purchaseView(task.purchase, task.state) } : {}),
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
