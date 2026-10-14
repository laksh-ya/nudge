import { v } from "convex/values";
import { country as countryInfo } from "@agent-wallet/domain";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { currency } from "./schema";
import { requireViewer, viewer } from "./lib/auth";
import { wipeUser } from "./lib/wipe";

const DAY = 86_400_000;
export const STEPS = ["you", "goals", "sources", "history", "review", "assistant", "wallet", "chat", "people", "done"] as const;

function minorOk(n: number) {
  return Number.isSafeInteger(n) && n >= 0 && n <= 1e13;
}

export const state = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return null;
    const [accounts, obligations, wallet, agents, family, link] = await Promise.all([
      ctx.db.query("accounts").withIndex("by_user", (q) => q.eq("userId", user._id)).take(100),
      ctx.db.query("obligations").withIndex("by_user_due", (q) => q.eq("userId", user._id)).take(200),
      ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique(),
      ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50),
      ctx.db.query("family").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50),
      ctx.db.query("chatLinks").withIndex("by_user", (q) => q.eq("userId", user._id)).first(),
    ]);
    return {
      user: {
        name: user.name,
        country: user.country,
        currency: user.currency,
        timezone: user.timezone,
        incomeDay: user.incomeDay,
        priorities: user.priorities ?? [],
        autonomy: user.autonomy ?? "draft",
        reminderChannel: user.reminderChannel ?? "app",
        quietFrom: user.quietFrom ?? "22:00",
        quietTo: user.quietTo ?? "08:00",
        reminderLeadDays: user.reminderLeadDays ?? 2,
        monthlyBudgetMinor: user.monthlyBudgetMinor,
        emergencyMinor: user.emergencyMinor,
        step: user.onboardingStep ?? (user.onboardedAt ? null : "you"),
        onboardedAt: user.onboardedAt,
      },
      counts: {
        accounts: accounts.length,
        withHistory: accounts.filter((a) => a.status === "ok").length,
        suggested: obligations.filter((o) => o.status === "suggested").length,
        confirmed: obligations.filter((o) => o.status === "active").length,
      },
      wallet,
      agents: agents.map((a) => ({ _id: a._id, provider: a.provider, name: a.name, status: a.status })),
      family: family.map((f) => ({ _id: f._id, name: f.name, relation: f.relation, status: f.status })),
      chat: link ? { code: link.code, linked: Boolean(link.linkedAt), channel: link.channel } : null,
      bot: process.env.TELEGRAM_BOT_USERNAME ?? null,
    };
  },
});

export const setStep = mutation({
  args: { step: v.string() },
  handler: async (ctx, { step }) => {
    const user = await requireViewer(ctx);
    if (!(STEPS as readonly string[]).includes(step)) throw new Error("Unknown step");
    await ctx.db.patch(user._id, { onboardingStep: step });
  },
});

export const savePreferences = mutation({
  args: {
    name: v.string(),
    country: v.string(),
    currency,
    timezone: v.string(),
    incomeDay: v.optional(v.number()),
    monthlyBudgetMinor: v.optional(v.number()),
    emergencyMinor: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await requireViewer(ctx);
    const name = args.name.trim().slice(0, 40);
    if (!name) throw new Error("Add your name");
    const c = countryInfo(args.country);
    let nextIncomeAt = user.nextIncomeAt;
    if (args.incomeDay !== undefined) {
      if (!Number.isInteger(args.incomeDay) || args.incomeDay < 1 || args.incomeDay > 31) throw new Error("Pick a day from 1 to 31");
      const now = new Date();
      const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), args.incomeDay, 6));
      if (next.getTime() <= now.getTime()) next.setUTCMonth(next.getUTCMonth() + 1);
      nextIncomeAt = next.getTime();
    }
    for (const n of [args.monthlyBudgetMinor, args.emergencyMinor]) if (n !== undefined && !minorOk(n)) throw new Error("Amount is out of range");
    await ctx.db.patch(user._id, {
      name,
      country: c.code,
      currency: args.currency,
      timezone: args.timezone.slice(0, 60),
      incomeDay: args.incomeDay ?? user.incomeDay,
      nextIncomeAt,
      monthlyBudgetMinor: args.monthlyBudgetMinor ?? user.monthlyBudgetMinor,
      emergencyMinor: args.emergencyMinor ?? user.emergencyMinor,
    });
  },
});

export const savePriorities = mutation({
  args: { priorities: v.array(v.string()) },
  handler: async (ctx, { priorities }) => {
    const user = await requireViewer(ctx);
    await ctx.db.patch(user._id, { priorities: priorities.slice(0, 10).map((p) => p.slice(0, 20)) });
  },
});

const autonomy = v.union(v.literal("draft"), v.literal("approve"), v.literal("limited"));

async function ownAssistant(ctx: MutationCtx, user: Doc<"users">, mode: "draft" | "approve" | "limited", wallet: Doc<"wallets"> | null) {
  const agents = await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50);
  const scopes: Doc<"agents">["scopes"] =
    mode === "draft" ? ["read", "prepare"] : mode === "approve" ? ["read", "prepare", "request"] : ["read", "prepare", "spend", "request"];
  const cap = mode === "limited" ? (wallet?.dailyCeilingMinor ?? 2_000) : 0;
  const per = mode === "limited" ? (wallet?.perPaymentMinor ?? 1_000) : 0;
  const existing = agents.find((a) => a.provider === "own");
  if (existing) {
    await ctx.db.patch(existing._id, { scopes, dailyCapMinor: cap, perPaymentMinor: per });
  } else {
    await ctx.db.insert("agents", {
      userId: user._id,
      name: "Your assistant",
      provider: "own",
      status: "active",
      scopes,
      dailyCapMinor: cap,
      perPaymentMinor: per,
      spentTodayMinor: 0,
      hidesBalances: false,
      connectedAt: Date.now(),
      expiresAt: Date.now() + 365 * DAY,
    });
  }
}

export const saveAssistant = mutation({
  args: {
    autonomy,
    reminderChannel: v.union(v.literal("app"), v.literal("telegram"), v.literal("whatsapp")),
    quietFrom: v.string(),
    quietTo: v.string(),
    reminderLeadDays: v.number(),
  },
  handler: async (ctx, args) => {
    const user = await requireViewer(ctx);
    if (!/^\d{2}:\d{2}$/.test(args.quietFrom) || !/^\d{2}:\d{2}$/.test(args.quietTo)) throw new Error("Use HH:MM");
    if (!Number.isInteger(args.reminderLeadDays) || args.reminderLeadDays < 0 || args.reminderLeadDays > 14) throw new Error("Pick 0 to 14 days");
    await ctx.db.patch(user._id, args);
    const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    await ownAssistant(ctx, user, args.autonomy, wallet);
  },
});

export const setupWallet = mutation({
  args: { dailyCeilingMinor: v.number(), protectedMinor: v.number(), perPaymentMinor: v.number() },
  handler: async (ctx, args) => {
    const user = await requireViewer(ctx);
    for (const n of Object.values(args)) if (!minorOk(n)) throw new Error("Amount is out of range");
    if (args.perPaymentMinor > args.dailyCeilingMinor) throw new Error("A single payment can't exceed the daily ceiling");
    const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    if (wallet) {
      // Tightening applies now; loosening will need the passkey once signing is connected.
      await ctx.db.patch(wallet._id, args);
    } else {
      await ctx.db.insert("wallets", {
        userId: user._id,
        address: "",
        chain: "base-sepolia",
        asset: "USDC",
        balanceMinor: 0,
        frozen: false,
        ...args,
      });
      await ctx.db.insert("activity", {
        userId: user._id,
        kind: "setting",
        title: "Agent wallet set up",
        detail: `Agents can spend up to $${(args.dailyCeilingMinor / 100).toFixed(2)} a day`,
        tone: "neutral",
      });
    }
    const fresh = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    await ownAssistant(ctx, user, user.autonomy ?? "draft", fresh);
  },
});

export const addTestFunds = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireViewer(ctx);
    const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    if (!wallet) throw new Error("Set up the wallet first");
    if (wallet.balanceMinor >= 100_000) throw new Error("Test balance is capped at $1,000");
    await ctx.db.patch(wallet._id, { balanceMinor: wallet.balanceMinor + 10_000 });
    await ctx.db.insert("activity", { userId: user._id, kind: "payment", title: "Added $100.00 test USDC", detail: "Simulated funds", tone: "neutral" });
  },
});

function pairingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** Linking always starts here, in the signed-in app, never from the chat side. */
export const chatCode = mutation({
  args: { channel: v.union(v.literal("telegram"), v.literal("whatsapp")) },
  handler: async (ctx, { channel }) => {
    const user = await requireViewer(ctx);
    const existing = await ctx.db.query("chatLinks").withIndex("by_user", (q) => q.eq("userId", user._id)).take(10);
    const same = existing.find((l) => l.channel === channel);
    if (same) return same.code;
    const code = pairingCode();
    await ctx.db.insert("chatLinks", { userId: user._id, channel, code });
    return code;
  },
});

export const addAssistant = mutation({
  args: { provider: v.union(v.literal("claude"), v.literal("chatgpt"), v.literal("openclaw"), v.literal("hermes"), v.literal("poke")) },
  handler: async (ctx, { provider }) => {
    const user = await requireViewer(ctx);
    const agents = await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50);
    const found = agents.find((a) => a.provider === provider && a.status !== "revoked");
    if (found) return found._id;
    const names = { claude: "Claude", chatgpt: "ChatGPT", openclaw: "OpenClaw", hermes: "Hermes", poke: "Poke" };
    return await ctx.db.insert("agents", {
      userId: user._id,
      name: names[provider],
      provider,
      status: "pending",
      scopes: ["read"],
      dailyCapMinor: 0,
      perPaymentMinor: 0,
      spentTodayMinor: 0,
      hidesBalances: true,
      connectedAt: Date.now(),
      expiresAt: Date.now() + 30 * DAY,
    });
  },
});

export const removeAssistant = mutation({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const user = await requireViewer(ctx);
    const agent = await ctx.db.get(agentId);
    if (!agent || agent.userId !== user._id || agent.provider === "own") throw new Error("Not found");
    await ctx.db.delete(agentId);
  },
});

export const inviteFamily = mutation({
  args: { name: v.string(), relation: v.string(), country: v.string() },
  handler: async (ctx, args) => {
    const user = await requireViewer(ctx);
    const name = args.name.trim().slice(0, 40);
    if (!name) throw new Error("Add their name");
    const c = countryInfo(args.country);
    return await ctx.db.insert("family", {
      userId: user._id,
      name,
      relation: args.relation.trim().slice(0, 30) || "Family",
      country: c.name,
      currency: c.currency,
      status: "invited",
    });
  },
});

export const complete = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireViewer(ctx);
    await ctx.db.patch(user._id, { onboardedAt: user.onboardedAt ?? Date.now(), onboardingStep: undefined });
    if (!user.onboardedAt) {
      await ctx.db.insert("messages", {
        userId: user._id,
        role: "assistant",
        text: `Hi ${user.name}. I can tell you what you can spend, list bills and subscriptions, and prepare payments. Try asking me something.`,
        channel: "app",
      });
    }
  },
});

/** Walk through setup again. With `fresh`, delete all of this user's data first. */
export const restart = mutation({
  args: { fresh: v.boolean() },
  handler: async (ctx, { fresh }) => {
    const user = await requireViewer(ctx);
    if (fresh) {
      await wipeUser(ctx, user._id);
      await ctx.db.patch(user._id, { onboardedAt: undefined, priorities: [], autonomy: undefined, incomeDay: undefined, nextIncomeAt: Date.now() + 30 * DAY });
    }
    await ctx.db.patch(user._id, { onboardingStep: "you" });
  },
});
