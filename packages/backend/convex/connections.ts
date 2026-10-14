import { v } from "convex/values";
import { country as countryInfo, decimalsOf, detectAddress } from "@agent-wallet/domain";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { capability, currency, sourceKind } from "./schema";
import { own, requireViewer, viewer } from "./lib/auth";
import { ingest } from "./lib/ledger";
import { sandboxHistory } from "./lib/sandbox";

const MAX_ACCOUNTS = 100;

export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return [];
    const accounts = await ctx.db.query("accounts").withIndex("by_user", (q) => q.eq("userId", user._id)).take(MAX_ACCOUNTS);
    return await Promise.all(
      accounts.map(async (a) => {
        const imports = await ctx.db.query("imports").withIndex("by_account", (q) => q.eq("accountId", a._id)).take(200);
        const holdings = a.kind === "crypto" ? await ctx.db.query("holdings").withIndex("by_account", (q) => q.eq("accountId", a._id)).take(100) : [];
        return {
          ...a,
          transactions: imports.reduce((s, i) => s + i.added + i.duplicates, 0),
          imports: imports.length,
          fromAt: imports.reduce<number | undefined>((m, i) => (i.fromAt && (!m || i.fromAt < m) ? i.fromAt : m), undefined),
          holdings: holdings.sort((x, y) => y.usdMinor - x.usdMinor),
        };
      }),
    );
  },
});

export const get = query({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }) => {
    const user = await viewer(ctx);
    if (!user) return null;
    const account = await ctx.db.get(accountId);
    if (!account || account.userId !== user._id) return null;
    const [imports, holdings, recent] = await Promise.all([
      ctx.db.query("imports").withIndex("by_account", (q) => q.eq("accountId", accountId)).order("desc").take(50),
      ctx.db.query("holdings").withIndex("by_account", (q) => q.eq("accountId", accountId)).take(100),
      ctx.db.query("transactions").withIndex("by_account_at", (q) => q.eq("accountId", accountId)).order("desc").take(30),
    ]);
    return { account, imports, holdings: holdings.sort((x, y) => y.usdMinor - x.usdMinor), recent };
  },
});

export const add = mutation({
  args: {
    kind: sourceKind,
    name: v.string(),
    institution: v.string(),
    providerId: v.optional(v.string()),
    country: v.optional(v.string()),
    currency,
    method: v.union(v.literal("sandbox"), v.literal("statement"), v.literal("onchain"), v.literal("manual")),
    can: v.array(capability),
    uses: v.optional(v.array(v.string())),
    last4: v.optional(v.string()),
    network: v.optional(v.string()),
    expiry: v.optional(v.string()),
    chain: v.optional(v.union(v.literal("evm"), v.literal("bitcoin"), v.literal("solana"))),
    address: v.optional(v.string()),
    openingBalanceMinor: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await requireViewer(ctx);
    const existing = await ctx.db.query("accounts").withIndex("by_user", (q) => q.eq("userId", user._id)).take(MAX_ACCOUNTS);
    if (existing.length >= MAX_ACCOUNTS) throw new Error("You can add up to 100 accounts");
    const name = args.name.trim().slice(0, 60) || args.institution;
    if (args.last4 !== undefined && !/^\d{4}$/.test(args.last4)) throw new Error("Use the last 4 digits only");
    if (args.expiry !== undefined && !/^(0[1-9]|1[0-2])\/\d{2}$/.test(args.expiry)) throw new Error("Expiry looks like MM/YY");
    const opening = args.openingBalanceMinor ?? 0;
    if (!Number.isSafeInteger(opening) || Math.abs(opening) > 1e14) throw new Error("Balance is out of range");
    if (args.kind === "crypto" && args.address) {
      const address = args.address.trim();
      const family = detectAddress(address);
      if (!family || (args.chain && family !== args.chain)) throw new Error("That doesn't look like a wallet address");
      if (existing.some((a) => a.address?.toLowerCase() === address.toLowerCase())) throw new Error("This address is already added");
    }
    // A connection never grants spending authority. Only the agent wallet can execute.
    const can = args.can.filter((c) => c !== "execute");
    const accountId = await ctx.db.insert("accounts", {
      userId: user._id,
      kind: args.kind,
      name,
      institution: args.institution.trim().slice(0, 60),
      providerId: args.providerId,
      country: args.country,
      last4: args.last4,
      network: args.network,
      expiry: args.expiry,
      currency: args.kind === "crypto" ? "USD" : args.currency,
      balanceMinor: opening,
      syncedAt: Date.now(),
      source: args.method,
      can,
      uses: args.uses?.slice(0, 6),
      status: args.method === "sandbox" || args.method === "onchain" ? "syncing" : args.method === "manual" && opening !== 0 ? "ok" : "empty",
      chain: args.chain,
      address: args.address?.trim(),
      verified: false,
    });
    if (args.method === "sandbox") {
      await ctx.scheduler.runAfter(900, internal.connections.runSandbox, { accountId });
    }
    if (args.method === "onchain") {
      await ctx.scheduler.runAfter(0, internal.crypto.refresh, { accountId });
    }
    await ctx.db.insert("activity", {
      userId: user._id,
      kind: "import",
      title: `Added ${name}`,
      detail: args.method === "sandbox" ? "Connecting in sandbox" : args.method === "onchain" ? "Reading balances on-chain" : undefined,
      tone: "neutral",
    });
    return accountId;
  },
});

export const update = mutation({
  args: {
    accountId: v.id("accounts"),
    name: v.optional(v.string()),
    uses: v.optional(v.array(v.string())),
    balanceMinor: v.optional(v.number()),
  },
  handler: async (ctx, { accountId, name, uses, balanceMinor }) => {
    const user = await requireViewer(ctx);
    const account = await own(user, await ctx.db.get(accountId));
    if (balanceMinor !== undefined && (!Number.isSafeInteger(balanceMinor) || Math.abs(balanceMinor) > 1e14)) throw new Error("Balance is out of range");
    await ctx.db.patch(account._id, {
      name: name?.trim().slice(0, 60) || account.name,
      uses: uses?.slice(0, 6) ?? account.uses,
      ...(balanceMinor !== undefined ? { balanceMinor, syncedAt: Date.now(), status: "ok" as const } : {}),
    });
  },
});

export const remove = mutation({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }) => {
    const user = await requireViewer(ctx);
    const account = await own(user, await ctx.db.get(accountId));
    const [txs, imports, holdings] = await Promise.all([
      ctx.db.query("transactions").withIndex("by_account_at", (q) => q.eq("accountId", accountId)).take(4000),
      ctx.db.query("imports").withIndex("by_account", (q) => q.eq("accountId", accountId)).take(500),
      ctx.db.query("holdings").withIndex("by_account", (q) => q.eq("accountId", accountId)).take(500),
    ]);
    for (const d of [...txs, ...imports, ...holdings]) await ctx.db.delete(d._id);
    await ctx.db.delete(account._id);
    await ctx.db.insert("activity", { userId: user._id, kind: "import", title: `Removed ${account.name}`, tone: "neutral" });
  },
});

export const reconnect = mutation({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }) => {
    const user = await requireViewer(ctx);
    const account = await own(user, await ctx.db.get(accountId));
    if (account.source === "sandbox") {
      await ctx.db.patch(account._id, { status: "syncing" });
      await ctx.scheduler.runAfter(600, internal.connections.runSandbox, { accountId });
    } else if (account.source === "onchain") {
      await ctx.db.patch(account._id, { status: "syncing" });
      await ctx.scheduler.runAfter(0, internal.crypto.refresh, { accountId });
    }
  },
});

function transferHistory(account: Doc<"accounts">) {
  const unit = 10 ** decimalsOf(account.currency);
  const now = Date.now();
  return [80, 50, 20].flatMap((daysAgo, i) => [
    { at: now - daysAgo * 86_400_000, amountMinor: Math.round((400 + i * 50) * unit), description: "Top up from bank" },
    { at: now - (daysAgo - 1) * 86_400_000, amountMinor: -Math.round((400 + i * 50) * unit), description: "Transfer to Ananya Mehta" },
  ]);
}

/** What a sandboxed bank or transfer-provider connection returns: balance plus about three months of history. */
export const runSandbox = internalMutation({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }) => {
    const account = await ctx.db.get(accountId);
    if (!account) return;
    const user = (await ctx.db.get(account.userId))!;
    const c = countryInfo(account.country ?? user.country);
    const rows =
      account.kind === "transfer"
        ? transferHistory(account)
        : sandboxHistory(account._id, c.code, account.currency, decimalsOf(account.currency));
    const importId = await ctx.db.insert("imports", {
      userId: user._id,
      accountId,
      kind: "sandbox",
      fileName: `${account.institution} sandbox feed`,
      rows: rows.length,
      added: 0,
      duplicates: 0,
      transfers: 0,
    });
    const result = await ingest(ctx, user, { ...account, status: "empty" }, rows, importId);
    await ctx.db.patch(importId, result);
    await ctx.db.insert("activity", {
      userId: user._id,
      kind: "import",
      title: `Connected ${account.name}`,
      detail: `${result.added} transactions from the sandbox feed`,
      tone: "good",
    });
  },
});
