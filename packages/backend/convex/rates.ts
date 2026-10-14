import { v } from "convex/values";
import { CHAINS, FALLBACK_USD_RATES, FIAT_CODES } from "@agent-wallet/domain";
import { internalAction, internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { QueryCtx } from "./_generated/server";
import { fetchPrices } from "./crypto";

export async function latestRates(ctx: QueryCtx) {
  const doc = await ctx.db.query("rates").withIndex("by_fetched").order("desc").first();
  return {
    fiat: { ...FALLBACK_USD_RATES, ...(doc?.fiat ?? {}) },
    crypto: doc?.crypto ?? {},
    date: doc?.date ?? "2026-10-14",
    live: Boolean(doc),
  };
}

export const latest = query({
  args: {},
  handler: async (ctx) => latestRates(ctx),
});

export const save = internalMutation({
  args: { date: v.string(), fiat: v.record(v.string(), v.number()), crypto: v.record(v.string(), v.number()) },
  handler: async (ctx, args) => {
    await ctx.db.insert("rates", { ...args, fetchedAt: Date.now() });
    const old = await ctx.db.query("rates").withIndex("by_fetched").order("asc").take(50);
    for (const d of old.slice(0, Math.max(0, old.length - 30))) await ctx.db.delete(d._id);
  },
});

/** ECB reference rates (Frankfurter) and CoinGecko prices, once a day. */
export const refresh = internalAction({
  args: {},
  handler: async (ctx) => {
    const symbols = FIAT_CODES.filter((c) => c !== "USD" && c !== "AED").join(",");
    const res = await fetch(`https://api.frankfurter.dev/v1/latest?base=USD&symbols=${symbols}`);
    const fx = res.ok ? ((await res.json()) as { date: string; rates: Record<string, number> }) : null;
    const ids = [...new Set(CHAINS.flatMap((c) => [c.coingecko, ...(c.tokens ?? []).map((t) => t.coingecko)]).filter(Boolean))];
    const crypto = await fetchPrices(ids);
    await ctx.runMutation(internal.rates.save, {
      date: fx?.date ?? new Date().toISOString().slice(0, 10),
      fiat: { USD: 1, AED: 3.6725, ...(fx?.rates ?? {}) },
      crypto,
    });
  },
});
