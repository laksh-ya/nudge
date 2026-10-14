import { v } from "convex/values";
import { createPublicClient, erc20Abi, formatUnits, http, isAddress, verifyMessage } from "viem";
import { CHAINS } from "@agent-wallet/domain";
import { action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

type Holding = { chain: string; asset: string; amount: number; coingecko: string };

async function evmHoldings(address: `0x${string}`): Promise<Holding[]> {
  const chains = CHAINS.filter((c) => c.family === "evm");
  const results = await Promise.allSettled(
    chains.map(async (c) => {
      const client = createPublicClient({ transport: http(c.rpc, { timeout: 8_000, retryCount: 1 }) });
      const native = await client.getBalance({ address });
      const out: Holding[] = [];
      if (native > 0n) out.push({ chain: c.id, asset: c.native, amount: Number(formatUnits(native, 18)), coingecko: c.coingecko });
      for (const t of c.tokens ?? []) {
        const bal = await client.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [address] });
        if (bal > 0n) out.push({ chain: c.id, asset: t.symbol, amount: Number(formatUnits(bal, t.decimals)), coingecko: t.coingecko });
      }
      return out;
    }),
  );
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed === results.length) throw new Error("Couldn't reach any network");
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

async function bitcoinHoldings(address: string): Promise<Holding[]> {
  const res = await fetch(`https://mempool.space/api/address/${encodeURIComponent(address)}`);
  if (!res.ok) throw new Error("Bitcoin address not found");
  const d = (await res.json()) as { chain_stats: { funded_txo_sum: number; spent_txo_sum: number }; mempool_stats: { funded_txo_sum: number; spent_txo_sum: number } };
  const sats = d.chain_stats.funded_txo_sum - d.chain_stats.spent_txo_sum + d.mempool_stats.funded_txo_sum - d.mempool_stats.spent_txo_sum;
  return sats > 0 ? [{ chain: "bitcoin", asset: "BTC", amount: sats / 1e8, coingecko: "bitcoin" }] : [];
}

async function solanaHoldings(address: string): Promise<Holding[]> {
  const rpc = CHAINS.find((c) => c.id === "solana")!.rpc!;
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] }),
  });
  const d = (await res.json()) as { result?: { value: number }; error?: { message: string } };
  if (d.error) throw new Error("Solana address not found");
  const lamports = d.result?.value ?? 0;
  return lamports > 0 ? [{ chain: "solana", asset: "SOL", amount: lamports / 1e9, coingecko: "solana" }] : [];
}

export const accountForRefresh = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }) => await ctx.db.get(accountId),
});

export const prices = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("rates").withIndex("by_fetched").order("desc").first())?.crypto ?? {},
});

export const saveHoldings = internalMutation({
  args: {
    accountId: v.id("accounts"),
    holdings: v.array(v.object({ chain: v.string(), asset: v.string(), amount: v.number(), usdMinor: v.number() })),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { accountId, holdings, error }) => {
    const account = await ctx.db.get(accountId);
    if (!account) return;
    if (error) {
      await ctx.db.patch(accountId, { status: "error", statusNote: error });
      return;
    }
    const old = await ctx.db.query("holdings").withIndex("by_account", (q) => q.eq("accountId", accountId)).take(500);
    for (const h of old) await ctx.db.delete(h._id);
    const now = Date.now();
    for (const h of holdings) await ctx.db.insert("holdings", { ...h, userId: account.userId, accountId, updatedAt: now });
    await ctx.db.patch(accountId, {
      balanceMinor: holdings.reduce((s, h) => s + h.usdMinor, 0),
      syncedAt: now,
      status: "ok",
      statusNote: holdings.length === 0 ? "No balance on supported networks" : undefined,
    });
  },
});

/** Read live balances for a watched address and value them in USD. Test-network assets are valued at zero. */
export const refresh = internalAction({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }) => {
    const account = await ctx.runQuery(internal.crypto.accountForRefresh, { accountId });
    if (!account?.address || !account.chain) return;
    try {
      const list =
        account.chain === "evm"
          ? await evmHoldings(account.address as `0x${string}`)
          : account.chain === "bitcoin"
            ? await bitcoinHoldings(account.address)
            : await solanaHoldings(account.address);
      let prices: Record<string, number> = await ctx.runQuery(internal.crypto.prices, {});
      const missing = [...new Set(list.map((h) => h.coingecko).filter((id) => id && prices[id] === undefined))];
      if (missing.length) prices = { ...prices, ...(await fetchPrices(missing)) };
      const holdings = list.map((h) => ({
        chain: h.chain,
        asset: h.asset,
        amount: h.amount,
        usdMinor: h.coingecko ? Math.round(h.amount * (prices[h.coingecko] ?? 0) * 100) : 0,
      }));
      await ctx.runMutation(internal.crypto.saveHoldings, { accountId, holdings });
    } catch (e) {
      await ctx.runMutation(internal.crypto.saveHoldings, {
        accountId,
        holdings: [],
        error: e instanceof Error ? e.message.slice(0, 120) : "Couldn't read balances",
      });
    }
  },
});

const SYMBOL: Record<string, string> = {
  bitcoin: "BTC",
  ethereum: "ETH",
  solana: "SOL",
  "polygon-ecosystem-token": "POL",
  binancecoin: "BNB",
  "usd-coin": "USDC",
  tether: "USDT",
};

/** USD prices keyed by CoinGecko id. CoinGecko first, Coinbase spot prices when CoinGecko refuses. */
export async function fetchPrices(ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const out: Record<string, number> = {};
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`);
    if (res.ok) {
      const d = (await res.json()) as Record<string, { usd?: number }>;
      for (const [k, val] of Object.entries(d)) if (val.usd) out[k] = val.usd;
    }
  } catch {}
  const missing = ids.filter((id) => out[id] === undefined && SYMBOL[id]);
  await Promise.all(
    missing.map(async (id) => {
      const sym = SYMBOL[id]!;
      if (sym === "USDC" || sym === "USDT") {
        out[id] = 1;
        return;
      }
      try {
        const res = await fetch(`https://api.coinbase.com/v2/prices/${sym}-USD/spot`);
        if (!res.ok) return;
        const d = (await res.json()) as { data?: { amount?: string } };
        const p = Number(d.data?.amount);
        if (p > 0) out[id] = p;
      } catch {}
    }),
  );
  return out;
}

export const markVerified = internalMutation({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }) => {
    const account = await ctx.db.get(accountId);
    if (!account) return;
    await ctx.db.patch(accountId, { verified: true });
    await ctx.db.insert("activity", {
      userId: account.userId,
      kind: "security",
      title: `Proved ownership of ${account.name}`,
      detail: "Signed a message with the wallet",
      tone: "good",
    });
  },
});

export const ownerOf = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, { accountId }) => {
    const identity = await ctx.auth.getUserIdentity();
    const token = identity?.tokenIdentifier ?? (process.env.DEMO_MODE === "true" ? "demo" : null);
    const account = await ctx.db.get(accountId);
    if (!token || !account) return null;
    const user = await ctx.db.get(account.userId);
    return user?.tokenIdentifier === token ? account : null;
  },
});

/**
 * Proof of ownership: the wallet signs a message naming this account and a recent time.
 * The signature is checked here; nothing is ever sent from the wallet.
 */
export const verifyOwnership = action({
  args: { accountId: v.id("accounts"), message: v.string(), signature: v.string() },
  handler: async (ctx, { accountId, message, signature }) => {
    const account = await ctx.runQuery(internal.crypto.ownerOf, { accountId });
    if (!account?.address || account.chain !== "evm" || !isAddress(account.address)) throw new Error("Not an EVM wallet");
    const issued = Number(message.match(/Issued at: (\d+)/)?.[1]);
    if (!message.includes(accountId) || !Number.isFinite(issued) || Math.abs(Date.now() - issued) > 10 * 60_000) {
      throw new Error("This signature request expired. Try again.");
    }
    const ok = await verifyMessage({
      address: account.address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
    if (!ok) throw new Error("The signature doesn't match this address");
    await ctx.runMutation(internal.crypto.markVerified, { accountId });
    return true;
  },
});
