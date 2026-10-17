import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { merchantKey } from "@agent-wallet/domain";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { own, requireViewer, viewer } from "./lib/auth";

export const accounts = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return [];
    return await ctx.db.query("accounts").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50);
  },
});

export const transactions = query({
  args: { paginationOpts: paginationOptsValidator, category: v.optional(v.string()), accountId: v.optional(v.id("accounts")) },
  handler: async (ctx, { paginationOpts, category, accountId }) => {
    const user = await viewer(ctx);
    if (!user) return { page: [], isDone: true, continueCursor: "" };
    if (accountId) {
      const account = await ctx.db.get(accountId);
      if (!account || account.userId !== user._id) return { page: [], isDone: true, continueCursor: "" };
      return await ctx.db
        .query("transactions")
        .withIndex("by_account_at", (q) => q.eq("accountId", accountId))
        .order("desc")
        .paginate(paginationOpts);
    }
    const q = category
      ? ctx.db
          .query("transactions")
          .withIndex("by_user_category_at", (q) => q.eq("userId", user._id).eq("category", category))
      : ctx.db.query("transactions").withIndex("by_user_at", (q) => q.eq("userId", user._id));
    return await q.order("desc").paginate(paginationOpts);
  },
});

export const obligations = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return [];
    return await ctx.db
      .query("obligations")
      .withIndex("by_user_due", (q) => q.eq("userId", user._id))
      .take(100);
  },
});

export const goals = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return [];
    return await ctx.db.query("goals").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50);
  },
});

const DAY = 86_400_000;

function minorOk(n: number) {
  return Number.isSafeInteger(n) && n > 0 && n <= 1e13;
}

export const transaction = query({
  args: { id: v.id("transactions") },
  handler: async (ctx, { id }) => {
    const user = await viewer(ctx);
    if (!user) return null;
    const t = await ctx.db.get(id);
    if (!t || t.userId !== user._id) return null;
    const [account, twin, receiptUrl] = await Promise.all([
      ctx.db.get(t.accountId),
      t.duplicateOf ? ctx.db.get(t.duplicateOf) : null,
      t.receiptId ? ctx.storage.getUrl(t.receiptId) : null,
    ]);
    const twinAccount = twin ? await ctx.db.get(twin.accountId) : null;
    return { ...t, account: account?.name, duplicateIn: twinAccount?.name, receiptUrl };
  },
});

/** A manual category change is kept forever; "always" also teaches a rule for this merchant. */
export const recategorize = mutation({
  args: { id: v.id("transactions"), category: v.string(), always: v.boolean(), note: v.optional(v.string()) },
  handler: async (ctx, { id, category, always, note }) => {
    const user = await requireViewer(ctx);
    const t = await own(user, await ctx.db.get(id));
    const cat = category.trim().slice(0, 30);
    await ctx.db.patch(t._id, { category: cat, categoryLocked: true, note: note?.slice(0, 200) ?? t.note });
    if (!always) return 0;
    const key = merchantKey(t.merchant);
    const rule = await ctx.db.query("rules").withIndex("by_user_key", (q) => q.eq("userId", user._id).eq("key", key)).unique();
    if (rule) await ctx.db.patch(rule._id, { category: cat });
    else await ctx.db.insert("rules", { userId: user._id, key, category: cat });
    const recent = await ctx.db
      .query("transactions")
      .withIndex("by_user_at", (q) => q.eq("userId", user._id).gte("at", Date.now() - 400 * DAY))
      .take(4000);
    let changed = 0;
    for (const o of recent) {
      if (o._id !== t._id && !o.categoryLocked && o.kind !== "transfer" && merchantKey(o.merchant) === key && o.category !== cat) {
        await ctx.db.patch(o._id, { category: cat });
        changed++;
      }
    }
    return changed;
  },
});

export const reviewSuggestion = mutation({
  args: { id: v.id("obligations"), keep: v.boolean() },
  handler: async (ctx, { id, keep }) => {
    const user = await requireViewer(ctx);
    const o = await own(user, await ctx.db.get(id));
    await ctx.db.patch(o._id, { status: keep ? "active" : "dismissed" });
  },
});

const payWith = v.union(v.literal("wallet"), v.literal("account"), v.literal("manual"));

/** The payee and account a bill names must be the owner's own; a wallet bill is in dollars. */
async function checkPayment(
  ctx: MutationCtx,
  user: Doc<"users">,
  p: { payWith?: "wallet" | "account" | "manual"; payeeId?: Id<"payees"> | null; accountId?: Id<"accounts"> | null },
) {
  if (p.payeeId) await own(user, await ctx.db.get(p.payeeId));
  if (p.accountId) await own(user, await ctx.db.get(p.accountId));
  if (p.payWith === "account" && !p.accountId) throw new ConvexError("Pick the account or card it's paid from");
  if (p.payWith === "wallet" && !p.payeeId) throw new ConvexError("Pick who it's paid to: a contact the wallet can pay");
}

export const updateObligation = mutation({
  args: {
    id: v.id("obligations"),
    autopayLimitMinor: v.optional(v.union(v.number(), v.null())),
    status: v.optional(v.union(v.literal("active"), v.literal("paused"), v.literal("cancelled"))),
    name: v.optional(v.string()),
    amountMinor: v.optional(v.number()),
    nextDueAt: v.optional(v.number()),
    cadence: v.optional(v.union(v.literal("weekly"), v.literal("monthly"), v.literal("yearly"))),
    payWith: v.optional(payWith),
    payeeId: v.optional(v.union(v.id("payees"), v.null())),
    accountId: v.optional(v.union(v.id("accounts"), v.null())),
  },
  handler: async (ctx, { id, autopayLimitMinor, status, name, amountMinor, nextDueAt, cadence, payWith: how, payeeId, accountId }) => {
    const user = await requireViewer(ctx);
    const o = await own(user, await ctx.db.get(id));
    if (typeof autopayLimitMinor === "number" && !minorOk(autopayLimitMinor)) throw new ConvexError("Amount is out of range");
    if (amountMinor !== undefined && !minorOk(amountMinor)) throw new ConvexError("Amount is out of range");
    if (nextDueAt !== undefined && !Number.isFinite(nextDueAt)) throw new ConvexError("Pick a date");
    const next = { payWith: how ?? o.payWith, payeeId: payeeId === undefined ? o.payeeId : payeeId, accountId: accountId === undefined ? o.accountId : accountId };
    if (how !== undefined || payeeId !== undefined || accountId !== undefined) await checkPayment(ctx, user, next);
    const clean = name?.trim().slice(0, 60);
    await ctx.db.patch(o._id, {
      ...(autopayLimitMinor !== undefined ? { autopayLimitMinor: autopayLimitMinor ?? undefined } : {}),
      ...(status ? { status } : {}),
      ...(clean ? { name: clean, merchantKey: merchantKey(clean) } : {}),
      ...(amountMinor !== undefined ? { amountMinor } : {}),
      ...(nextDueAt !== undefined ? { nextDueAt } : {}),
      ...(cadence ? { cadence } : {}),
      ...(how ? { payWith: how } : {}),
      ...(payeeId !== undefined ? { payeeId: payeeId ?? undefined } : {}),
      ...(accountId !== undefined ? { accountId: accountId ?? undefined } : {}),
      ...(how === "wallet" ? { currency: "USD" as const } : {}),
    });
  },
});

export const addObligation = mutation({
  args: {
    name: v.string(),
    kind: v.union(v.literal("bill"), v.literal("subscription")),
    amountMinor: v.number(),
    cadence: v.union(v.literal("weekly"), v.literal("monthly"), v.literal("yearly")),
    nextDueAt: v.number(),
    payWith: v.optional(payWith),
    payeeId: v.optional(v.id("payees")),
    accountId: v.optional(v.id("accounts")),
  },
  handler: async (ctx, args) => {
    const user = await requireViewer(ctx);
    const name = args.name.trim().slice(0, 60);
    if (!name) throw new ConvexError("Add a name");
    if (!minorOk(args.amountMinor)) throw new ConvexError("Amount is out of range");
    if (!Number.isFinite(args.nextDueAt)) throw new ConvexError("Pick a date");
    await checkPayment(ctx, user, args);
    return await ctx.db.insert("obligations", {
      userId: user._id,
      name,
      kind: args.kind,
      amountMinor: args.amountMinor,
      // A bill paid from the Nudge wallet is in its test dollars.
      currency: args.payWith === "wallet" ? "USD" : user.currency,
      cadence: args.cadence,
      nextDueAt: args.nextDueAt,
      status: "active",
      merchantKey: merchantKey(name),
      source: "manual",
      payWith: args.payWith ?? "manual",
      payeeId: args.payeeId,
      accountId: args.accountId,
    });
  },
});

export const addGoal = mutation({
  args: { name: v.string(), targetMinor: v.number(), icon: v.string() },
  handler: async (ctx, { name, targetMinor, icon }) => {
    const user = await requireViewer(ctx);
    const n = name.trim().slice(0, 40);
    if (!n) throw new ConvexError("Name your goal");
    if (!minorOk(targetMinor)) throw new ConvexError("Amount is out of range");
    return await ctx.db.insert("goals", { userId: user._id, name: n, icon: icon.slice(0, 20), targetMinor, savedMinor: 0, currency: user.currency });
  },
});

export const contribute = mutation({
  args: { goalId: v.id("goals"), amountMinor: v.number() },
  handler: async (ctx, { goalId, amountMinor }) => {
    const user = await requireViewer(ctx);
    const g = await own(user, await ctx.db.get(goalId));
    if (!Number.isSafeInteger(amountMinor) || amountMinor === 0 || Math.abs(amountMinor) > 1e13) throw new ConvexError("Amount is out of range");
    await ctx.db.patch(g._id, { savedMinor: Math.max(0, g.savedMinor + amountMinor) });
  },
});

export const setBudget = mutation({
  args: { monthlyBudgetMinor: v.number(), emergencyMinor: v.number() },
  handler: async (ctx, args) => {
    const user = await requireViewer(ctx);
    for (const n of Object.values(args)) if (!Number.isSafeInteger(n) || n < 0 || n > 1e13) throw new ConvexError("Amount is out of range");
    await ctx.db.patch(user._id, args);
  },
});
