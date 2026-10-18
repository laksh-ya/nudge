import { v, ConvexError } from "convex/values";
import { formatMoney } from "@agent-wallet/domain";
import { createPublicClient, getAddress, http as viemHttp, keccak256, parseEventLogs, toHex, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { load, payeeForAddress, propose } from "./gateway";
import { ownerPayTask } from "./lib/actions";
import { isVaultVersion } from "@agent-wallet/domain";
import { intentFor } from "./lib/mandates";
import { requireViewer, viewer } from "./lib/auth";
import { testUsdAbi } from "@agent-wallet/domain";
import {
  NETWORK,
  SCHEME,
  UNITS_PER_CENT,
  X402_VERSION,
  b64,
  checkReceipt,
  hostOf,
  priceAt,
  isPaymentRequired,
  pickOffer,
  simulatedReceipt,
  testCardNumber,
  unb64,
  type PaymentProof,
} from "./lib/commerce";

/**
 * Agent commerce: buying from x402 sites (pay_x402), AP2 human-not-present purchases (watch_price:
 * buy when the price drops), and one-time cards for card-only checkouts (get_card). Every purchase is
 * an ordinary payment decision (gateway.propose): inside the agent's limits it goes, otherwise the
 * owner gets an approval link. Nothing here can spend around the vault.
 *
 * Nudge also runs a small demo x402 store (http.ts → /x402/store) so the whole loop can be tried on
 * testnet: a 402 answer, a vault payment, proof, and the bought content.
 */

const DAY = 86_400_000;
const DELIVERY_TRIES = 120;

function token() {
  return process.env.TOKEN_ADDRESS ?? "0xB0ee01235A8e7903519B029c1530332f5847D932";
}

/** Where demo-store purchases are paid: a fixed address no one holds a key for (test dollars only). */
export function storeAddress() {
  return getAddress(process.env.STORE_ADDRESS ?? `0x${keccak256(toHex("nudge demo x402 store")).slice(-40)}`);
}
/** Where one-time card loads go (simulated issuer). */
export function cardAddress() {
  return getAddress(process.env.CARD_FUNDING_ADDRESS ?? `0x${keccak256(toHex("nudge simulated card issuer")).slice(-40)}`);
}

type Quote = { ok: true; cents: number; payTo: string; description: string; resource: string } | { ok: false; problem: string; status?: number; free?: string };

/** Ask a URL for its x402 price without paying. */
async function quote(url: string): Promise<Quote> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, problem: "That isn't a URL." };
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(u.host))) return { ok: false, problem: "Only https URLs can be bought from." };
  let res: Response;
  try {
    res = await fetch(u, { headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    return { ok: false, problem: `The site didn't answer (${e instanceof Error ? e.message : "network error"}).` };
  }
  if (res.status === 200) return { ok: false, problem: "That URL is free: it didn't ask for payment.", status: 200, free: (await res.text()).slice(0, 2000) };
  if (res.status !== 402) return { ok: false, problem: `The site answered ${res.status}, not 402 Payment Required.`, status: res.status };
  const body = await res.json().catch(() => null);
  if (!isPaymentRequired(body)) return { ok: false, problem: "The 402 answer isn't in x402 format (no accepts list)." };
  const pick = pickOffer(body, token());
  if ("problem" in pick) return { ok: false, problem: pick.problem };
  return { ok: true, cents: pick.cents, payTo: pick.offer.payTo, description: (pick.offer.description ?? "").slice(0, 120), resource: pick.offer.resource ?? url };
}

/** The purchase decision: the same propose() every payment uses, with what was bought attached. */
export const startPurchase = internalMutation({
  args: {
    agentId: v.id("agents"),
    kind: v.union(v.literal("x402"), v.literal("watch")),
    url: v.string(),
    payTo: v.string(),
    cents: v.number(),
    item: v.string(),
    requestId: v.optional(v.string()),
    watchId: v.optional(v.id("watches")),
  },
  handler: async (ctx, a) => {
    const merchant = a.payTo.toLowerCase() === storeAddress().toLowerCase() ? "Nudge demo store" : hostOf(a.url);
    const d = await propose(ctx, { agentId: a.agentId, toAddress: a.payTo, name: merchant, amount: a.cents / 100, reason: `Buy: ${a.item}`.slice(0, 140), requestId: a.requestId }, { kind: "merchant" });
    if (d.outcome === "submitted" || d.outcome === "needs_approval" || d.outcome === "duplicate") {
      const task = (await ctx.db.get(d.taskId))!;
      if (!task.purchase) await ctx.db.patch(d.taskId, { purchase: { kind: a.kind, url: a.url, item: a.item, merchant, watchId: a.watchId } });
      if (d.outcome !== "duplicate") await ctx.scheduler.runAfter(5_000, internal.commerce.deliver, { taskId: d.taskId, attempt: 0 });
    }
    return d;
  },
});

export const payX402 = internalAction({
  args: { agentId: v.id("agents"), url: v.string(), maxPrice: v.number(), requestId: v.optional(v.string()) },
  handler: async (ctx, { agentId, url, maxPrice, requestId }): Promise<Record<string, unknown>> => {
    await ctx.runQuery(internal.gateway.myLimits, { agentId });
    const q = await quote(url);
    if (!q.ok) return { outcome: "refused", code: "2015", reason: q.problem, ...(q.free ? { content: q.free } : {}) };
    if (!(maxPrice > 0) || q.cents > Math.round(maxPrice * 100)) {
      return { outcome: "refused", code: "2015", reason: `The price is ${formatMoney(q.cents, "USDC")}, above your maxPrice of ${formatMoney(Math.round(maxPrice * 100), "USDC")}. Ask the user before paying more.` };
    }
    const d = await ctx.runMutation(internal.commerce.startPurchase, { agentId, kind: "x402", url: q.resource, payTo: q.payTo, cents: q.cents, item: q.description || hostOf(url), requestId });
    return { ...d, price: formatMoney(q.cents, "USDC"), item: q.description || null, note: "When get_task_status says confirmed, it includes the bought resource." };
  },
});

/** How the buyer's wallet introduces itself to the shop: "Instinct for Aarav", or "Aarav". */
export const buyerLabel = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task) return "A Nudge wallet";
    const user = await ctx.db.get(task.userId);
    const agent = task.agentId ? await ctx.db.get(task.agentId) : null;
    const name = user?.name || "A Nudge user";
    return agent && agent.provider !== "own" ? `${agent.name} for ${name}` : name;
  },
});

export const taskForDelivery = internalQuery({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task) return null;
    const payee = task.payeeId ? await ctx.db.get(task.payeeId) : null;
    return { task, payTo: payee?.address ?? null };
  },
});

export const saveDelivery = internalMutation({
  args: { taskId: v.id("tasks"), resource: v.optional(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, { taskId, resource, error }) => {
    const task = await ctx.db.get(taskId);
    if (!task?.purchase) return;
    await ctx.db.patch(taskId, { purchase: { ...task.purchase, resource: resource?.slice(0, 4000), deliveryError: error?.slice(0, 300) } });
    if (task.purchase.watchId) {
      const w = await ctx.db.get(task.purchase.watchId);
      if (w && w.status !== "cancelled") await ctx.db.patch(w._id, { status: "bought", taskId });
    }
    if (resource) await ctx.db.insert("activity", { userId: task.userId, kind: "payment", title: `Bought ${task.purchase.item ?? "an item"}`, detail: task.purchase.merchant ?? undefined, tone: "good" });
  },
});

/**
 * After the payment confirms, fetch what was bought with proof of payment (x402 retry). Polls the
 * task while it is held or waiting for the owner, then stops.
 */
export const deliver = internalAction({
  args: { taskId: v.id("tasks"), attempt: v.number() },
  handler: async (ctx, { taskId, attempt }) => {
    const row = await ctx.runQuery(internal.commerce.taskForDelivery, { taskId });
    if (!row?.task.purchase || row.task.purchase.kind === "card" || row.task.purchase.resource) return;
    const { task, payTo } = row;
    if (["failed", "cancelled", "expired"].includes(task.state)) return;
    if (task.state !== "confirmed") {
      if (attempt < DELIVERY_TRIES) await ctx.scheduler.runAfter(attempt < 30 ? 10_000 : 60_000, internal.commerce.deliver, { taskId, attempt: attempt + 1 });
      return;
    }
    const cents = task.amountMinor ?? 0;
    // The payment was decided at the quoted price, when the task was created.
    const payload = task.txHash ? { txHash: task.txHash } : { receipt: await simulatedReceipt(task._id, payTo ?? "", cents, Math.floor(task._creationTime)) };
    const proof: PaymentProof = { x402Version: X402_VERSION, scheme: SCHEME, network: NETWORK, payload };
    try {
      const buyer = await ctx.runQuery(internal.commerce.buyerLabel, { taskId });
      const res = await fetch(task.purchase!.url!, {
        headers: { "X-PAYMENT": b64(proof), "X-BUYER": buyer, "X-VIA": task.purchase!.kind === "watch" ? "watch" : task.agentId ? "x402" : "checkout", accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      if (res.ok) await ctx.runMutation(internal.commerce.saveDelivery, { taskId, resource: text });
      else if (attempt < 5) await ctx.scheduler.runAfter(15_000, internal.commerce.deliver, { taskId, attempt: attempt + 1 });
      else await ctx.runMutation(internal.commerce.saveDelivery, { taskId, error: `The merchant answered ${res.status} after payment: ${text.slice(0, 200)}` });
    } catch (e) {
      if (attempt < 5) await ctx.scheduler.runAfter(15_000, internal.commerce.deliver, { taskId, attempt: attempt + 1 });
      else await ctx.runMutation(internal.commerce.saveDelivery, { taskId, error: e instanceof Error ? e.message : "network error" });
    }
  },
});

// ------------------------------------------------------------------------------- price watches

export const watchPrice = internalMutation({
  args: { agentId: v.id("agents"), url: v.string(), item: v.string(), maxPrice: v.number(), days: v.optional(v.number()) },
  handler: async (ctx, { agentId, url, item, maxPrice, days = 7 }) => {
    const { agent, user } = await load(ctx, agentId);
    try {
      if (!/^https?:$/.test(new URL(url).protocol)) throw new ConvexError("not http");
    } catch {
      throw new ConvexError("url must be an http(s) URL that answers 402");
    }
    if (!(maxPrice > 0) || maxPrice > 100_000) throw new ConvexError("maxPrice must be a positive number of US dollars");
    if (!Number.isInteger(days) || days < 1 || days > 30) throw new ConvexError("days must be 1 to 30");
    const open = (await ctx.db.query("watches").withIndex("by_user", (q) => q.eq("userId", user._id)).take(100)).filter((w) => w.status === "active");
    if (open.length >= 20) throw new ConvexError("Up to 20 price watches at a time. Cancel one first.");
    const name = item.trim().replace(/\s+/g, " ").slice(0, 80) || "the item";
    const maxPriceMinor = Math.round(maxPrice * 100);
    const expiresAt = Date.now() + days * DAY;
    const watchId = await ctx.db.insert("watches", { userId: user._id, agentId: agent._id, url, item: name, maxPriceMinor, status: "active", expiresAt });
    await ctx.db.insert("activity", { userId: user._id, kind: "agent", title: `${agent.name} is watching ${name}`, detail: `Buys at ${formatMoney(maxPriceMinor, "USDC")} or less`, tone: "neutral" });
    await ctx.scheduler.runAfter(0, internal.commerce.checkWatch, { watchId });
    const authority = await intentFor(ctx, agent);
    return {
      watchId,
      // AP2 human-not-present: the user's intent for this purchase, and the passkey-signed mandate
      // (the agent's limits in the vault) it is carried out under.
      intent: {
        natural_language_description: `Buy ${name} at ${formatMoney(maxPriceMinor, "USDC")} or less, before ${new Date(expiresAt).toISOString().slice(0, 10)}.`,
        merchants: [hostOf(url)],
        user_cart_confirmation_required: false,
        intent_expiry: new Date(expiresAt).toISOString(),
      },
      spendingAuthority: authority ?? "Simulated wallet: limits are enforced by Nudge, not yet by a vault.",
      message: `Watching. I'll buy ${name} as soon as it's ${formatMoney(maxPriceMinor, "USDC")} or less${agent.perPaymentMinor >= maxPriceMinor ? "" : "; the payment is above my own limit, so the user will get an approval link then"}.`,
    };
  },
});

export const watchRow = internalQuery({
  args: { watchId: v.id("watches") },
  handler: async (ctx, { watchId }) => await ctx.db.get(watchId),
});

export const noteWatch = internalMutation({
  args: { watchId: v.id("watches"), priceMinor: v.optional(v.number()), error: v.optional(v.string()), status: v.optional(v.union(v.literal("expired"), v.literal("waiting"), v.literal("bought"))), taskId: v.optional(v.id("tasks")) },
  handler: async (ctx, { watchId, priceMinor, error, status, taskId }) => {
    const w = await ctx.db.get(watchId);
    if (!w || w.status === "cancelled") return;
    await ctx.db.patch(watchId, { lastCheckedAt: Date.now(), ...(priceMinor !== undefined ? { lastPriceMinor: priceMinor } : {}), lastError: error, ...(status ? { status } : {}), ...(taskId ? { taskId } : {}) });
  },
});

export const checkWatch = internalAction({
  args: { watchId: v.id("watches") },
  handler: async (ctx, { watchId }) => {
    const w = await ctx.runQuery(internal.commerce.watchRow, { watchId });
    if (!w || w.status !== "active") return;
    if (w.expiresAt < Date.now()) return void (await ctx.runMutation(internal.commerce.noteWatch, { watchId, status: "expired" }));
    const q = await quote(w.url);
    if (!q.ok) return void (await ctx.runMutation(internal.commerce.noteWatch, { watchId, error: q.problem }));
    if (q.cents > w.maxPriceMinor) return void (await ctx.runMutation(internal.commerce.noteWatch, { watchId, priceMinor: q.cents }));
    try {
      const d = await ctx.runMutation(internal.commerce.startPurchase, { agentId: w.agentId, kind: "watch", url: q.resource, payTo: q.payTo, cents: q.cents, item: w.item, requestId: `watch:${watchId}`, watchId });
      if (d.outcome === "refused") await ctx.runMutation(internal.commerce.noteWatch, { watchId, priceMinor: q.cents, error: d.reason });
      else await ctx.runMutation(internal.commerce.noteWatch, { watchId, priceMinor: q.cents, status: d.outcome === "needs_approval" ? "waiting" : "bought", taskId: d.taskId });
    } catch (e) {
      await ctx.runMutation(internal.commerce.noteWatch, { watchId, priceMinor: q.cents, error: e instanceof Error ? e.message.slice(0, 200) : "error" });
    }
  },
});

/** Every minute: check each active watch. */
export const sweepWatches = internalMutation({
  args: {},
  handler: async (ctx) => {
    const active = await ctx.db.query("watches").withIndex("by_status", (q) => q.eq("status", "active")).take(200);
    for (const [i, w] of active.entries()) await ctx.scheduler.runAfter(i * 200, internal.commerce.checkWatch, { watchId: w._id });
  },
});

export const listWatches = internalQuery({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const { user } = await load(ctx, agentId);
    const rows = await ctx.db.query("watches").withIndex("by_user", (q) => q.eq("userId", user._id)).order("desc").take(50);
    return rows.map(watchView);
  },
});

function watchView(w: Doc<"watches">) {
  return {
    watchId: w._id,
    item: w.item,
    url: w.url,
    buyAtOrBelow: formatMoney(w.maxPriceMinor, "USDC"),
    lastPrice: w.lastPriceMinor !== undefined ? formatMoney(w.lastPriceMinor, "USDC") : null,
    status: w.status,
    taskId: w.taskId ?? null,
    lastCheckedAt: w.lastCheckedAt ? new Date(w.lastCheckedAt).toISOString() : null,
    problem: w.lastError ?? null,
    until: new Date(w.expiresAt).toISOString(),
  };
}

export const cancelWatch = internalMutation({
  args: { agentId: v.id("agents"), watchId: v.string() },
  handler: async (ctx, { agentId, watchId }) => {
    const { user } = await load(ctx, agentId);
    return await stopWatch(ctx, user._id, watchId);
  },
});

async function stopWatch(ctx: MutationCtx, userId: Id<"users">, watchId: string) {
  const id = ctx.db.normalizeId("watches", watchId);
  const w = id ? await ctx.db.get(id) : null;
  if (!w || w.userId !== userId) throw new ConvexError("No such price watch");
  if (w.status === "active" || w.status === "waiting") await ctx.db.patch(w._id, { status: "cancelled" });
  return { cancelled: true, item: w.item };
}

/** The owner's view of every watch (Agents → Purchases). */
export const myWatches = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return [];
    const rows = await ctx.db.query("watches").withIndex("by_user", (q) => q.eq("userId", user._id)).order("desc").take(50);
    const agents = new Map((await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50)).map((a) => [a._id, a.name]));
    return rows.map((w) => ({ ...watchView(w), agent: agents.get(w.agentId) ?? "An assistant" }));
  },
});

export const ownerCancelWatch = mutation({
  args: { watchId: v.id("watches") },
  handler: async (ctx, { watchId }) => {
    const user = await requireViewer(ctx);
    return await stopWatch(ctx, user._id, watchId);
  },
});

// ------------------------------------------------------------------------------- one-time cards

export const getCard = internalMutation({
  args: { agentId: v.id("agents"), amount: v.number(), merchant: v.string(), reason: v.string() },
  handler: async (ctx, { agentId, amount, merchant, reason }) => {
    const where = merchant.trim().slice(0, 60) || "a merchant";
    const d = await propose(ctx, { agentId, toAddress: cardAddress(), name: "Nudge cards (simulated)", amount, reason: `Card for ${where}: ${reason}`.slice(0, 140) }, { kind: "merchant" });
    if (d.outcome === "refused") return d;
    const number = testCardNumber(`${d.taskId}`);
    const exp = new Date(Date.now() + 30 * DAY);
    const card = { number, exp: `${String(exp.getUTCMonth() + 1).padStart(2, "0")}/${String(exp.getUTCFullYear()).slice(2)}`, cvc: String(100 + (Number(number.slice(-6)) % 900)), last4: number.slice(-4) };
    const task = (await ctx.db.get(d.taskId))!;
    if (!task.purchase) await ctx.db.patch(d.taskId, { purchase: { kind: "card", merchant: where, item: `One-time card for ${where}`, card } });
    return { ...d, card: { last4: card.last4, simulated: true }, note: "When get_task_status says confirmed, it includes the full card number, expiry and CVC. Test number only." };
  },
});

// ------------------------------------------------------------------------------- the demo store

/** The test shop's shelf. Physical goods return an order confirmation; digital goods return the thing itself. */
export const ITEMS = [
  { slug: "shoes", name: "Trail running shoes (size 9)", priceMinor: 1200, emoji: "👟", category: "Outdoors", blurb: "Grippy, light, waterproof. The classic thing to buy when the price drops.", content: "Order NDG-SHOES-9 confirmed: trail running shoes, size 9. Ships in 2 days. (Test shop: nothing is shipped.)" },
  { slug: "coffee", name: "Single-origin coffee beans, 250 g", priceMinor: 400, emoji: "☕", category: "Groceries", blurb: "Medium roast from Chikmagalur. A typical small agent purchase.", content: "Order NDG-COFFEE confirmed: 250 g single-origin beans, medium roast. (Test shop: nothing is shipped.)" },
  { slug: "headphones", name: "Wireless headphones", priceMinor: 4500, emoji: "🎧", category: "Electronics", blurb: "Noise cancelling, 30-hour battery. Above most agents' limits: watch it ask for your passkey.", content: "Order NDG-AUDIO-1 confirmed: wireless headphones, black. (Test shop: nothing is shipped.)" },
  { slug: "ticket", name: "Concert ticket, Saturday", priceMinor: 1500, emoji: "🎟️", category: "Events", blurb: "General admission. Delivered instantly as an e-ticket code.", content: "E-ticket NDG-TKT-7731, Saturday 8 pm, general admission. Show this code at the gate. (Test shop.)" },
  { slug: "book", name: "E-book: The Psychology of Money", priceMinor: 300, emoji: "📘", category: "Books", blurb: "Delivered as a download link right after payment.", content: "Download: https://example.com/ebooks/psychology-of-money.epub (Test shop: demo link.)" },
  { slug: "report", name: "Market data report", priceMinor: 50, emoji: "📊", category: "Data", blurb: "A pay-per-use data product for agents: 50 cents a report.", content: "Market data report: BTC 7-day volatility 2.1%, ETH 2.8%; tUSD peg 1.000. (Demo data.)" },
  { slug: "api", name: "One API call: weather in Shenzhen", priceMinor: 1, emoji: "🌤️", category: "API", blurb: "One cent a call. What x402 was made for: machines paying machines.", content: '{"city":"Shenzhen","tempC":27,"sky":"partly cloudy","source":"demo"}' },
  { slug: "plant", name: "Monstera plant, medium", priceMinor: 900, emoji: "🪴", category: "Home", blurb: "Comes in a recycled pot. A good one for a guardian to stop and question.", content: "Order NDG-PLANT-2 confirmed: medium monstera in a recycled pot. (Test shop: nothing is shipped.)" },
] as const;

async function itemRow(ctx: MutationCtx, slug: string) {
  const row = await ctx.db.query("storeItems").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
  if (row) return row;
  const item = ITEMS.find((i) => i.slug === slug);
  if (!item) return null;
  return (await ctx.db.get(await ctx.db.insert("storeItems", { slug: item.slug, name: item.name, priceMinor: item.priceMinor, basePriceMinor: item.priceMinor, content: item.content })))!;
}

async function applyPrice(ctx: MutationCtx, slug: string, priceMinor?: number) {
  const row = await itemRow(ctx, slug);
  if (!row) return null;
  const next = priceMinor === undefined ? row.basePriceMinor : Math.max(1, Math.min(100_000, Math.round(priceMinor)));
  const history = [...(row.history ?? []), { priceMinor: next, from: Date.now() }].slice(-20);
  await ctx.db.patch(row._id, { priceMinor: next, history });
  if (next !== row.basePriceMinor) await ctx.scheduler.runAfter(DAY, internal.commerce.setStorePrice, { slug });
  return { ...row, priceMinor: next };
}

export const storeItem = internalMutation({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => await itemRow(ctx, slug),
});

export const storeCatalog = internalMutation({
  args: {},
  handler: async (ctx) => {
    const out: Doc<"storeItems">[] = [];
    for (const i of ITEMS) out.push((await itemRow(ctx, i.slug))!);
    return out;
  },
});

/** Demo control: set an item's price (to try a price watch). Prices go back to their base after a day. */
export const setStorePrice = internalMutation({
  args: { slug: v.string(), priceMinor: v.optional(v.number()) },
  handler: async (ctx, { slug, priceMinor }) => await applyPrice(ctx, slug, priceMinor),
});

/** Whether this payment proof pays for this item, once. */
export const redeem = internalMutation({
  args: { proof: v.string(), slug: v.string(), buyer: v.optional(v.string()), via: v.optional(v.string()), tx: v.optional(v.string()), amountMinor: v.optional(v.number()) },
  handler: async (ctx, { proof, slug, buyer, via, tx, amountMinor }) => {
    if (await ctx.db.query("storeReceipts").withIndex("by_proof", (q) => q.eq("proof", proof)).unique()) return false;
    await ctx.db.insert("storeReceipts", { proof, slug });
    const row = await ctx.db.query("storeItems").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
    await ctx.db.insert("storeOrders", {
      slug,
      item: row?.name ?? slug,
      amountMinor: amountMinor ?? row?.priceMinor ?? 0,
      buyer: (buyer ?? "A Nudge wallet").slice(0, 60),
      via: via === "checkout" || via === "watch" ? via : "x402",
      tx: tx ?? "simulated",
      at: Date.now(),
    });
    return true;
  },
});

/** The seller's order book (public: buyer names are the labels their wallets sent). */
export const orders = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("storeOrders").withIndex("by_at").order("desc").take(30);
    return rows.map((o) => ({ ...o, tx: o.tx === "simulated" ? null : o.tx }));
  },
});

/** What I (and my assistants) bought, with the delivered goods. */
export const myPurchases = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return [];
    const tasks = await ctx.db.query("tasks").withIndex("by_user_updated", (q) => q.eq("userId", user._id)).order("desc").take(200);
    const agents = new Map((await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50)).map((a) => [a._id, a.name]));
    return tasks
      .filter((t) => t.purchase)
      .slice(0, 30)
      .map((t) => ({
        taskId: t._id,
        item: t.purchase!.item ?? t.title,
        kind: t.purchase!.kind,
        merchant: t.purchase!.merchant ?? null,
        amountMinor: t.amountMinor ?? 0,
        state: t.state,
        by: t.agentId ? (agents.get(t.agentId) ?? "An assistant") : "You",
        resource: t.state === "confirmed" ? (t.purchase!.resource ?? null) : null,
        card: t.state === "confirmed" && t.purchase!.card ? t.purchase!.card : null,
        approvalToken: t.state === "awaiting_approval" ? (t.approvalToken ?? null) : null,
        live: Boolean(t.action),
        txHash: t.txHash ?? null,
        at: t._creationTime,
      }));
  },
});

/**
 * Buy from the test shop yourself. Your own order: on a simulated wallet it's paid at once; on an
 * on-chain wallet it's a payment you approve with your passkey (the vault pays the shop directly).
 */
export const buyNow = mutation({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const user = await requireViewer(ctx);
    const row = await itemRow(ctx, slug);
    if (!row) throw new ConvexError("That item isn't in the shop");
    const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    if (!wallet) throw new ConvexError("Set up your Nudge wallet first (Wallet screen)");
    if (wallet.frozen || wallet.vault?.frozen) throw new ConvexError("Your wallet is frozen");
    const live = wallet.status === "live" && isVaultVersion(wallet.version);
    const free = live && wallet.vault ? wallet.vault.balanceMinor - wallet.vault.heldMinor : wallet.balanceMinor;
    if (free < row.priceMinor) throw new ConvexError("Not enough in your Nudge wallet");
    const payee = (await payeeForAddress(ctx, user, storeAddress(), "Nudge test shop", "merchant"))!;
    const site = process.env.CONVEX_SITE_URL ?? "";
    const purchase = { kind: "x402" as const, url: `${site}/x402/store/item?slug=${row.slug}`, item: row.name, merchant: "Nudge test shop" };
    if (live) {
      const { taskId, token } = await ownerPayTask(ctx, { user, payee, amountMinor: row.priceMinor, title: `Buy ${row.name}`, channel: "app", purpose: row.name, reason: "You're buying from the test shop with your wallet" });
      await ctx.db.patch(taskId, { purchase });
      await ctx.scheduler.runAfter(5_000, internal.commerce.deliver, { taskId, attempt: 0 });
      return { state: "approval" as const, token };
    }
    const taskId = await ctx.db.insert("tasks", {
      userId: user._id,
      title: `Buy ${row.name}`,
      channel: "app",
      payeeId: payee._id,
      amountMinor: row.priceMinor,
      currency: "USDC",
      purpose: row.name,
      state: "submitted",
      rail: "simulator",
      updatedAt: Date.now(),
      purchase,
    });
    await ctx.scheduler.runAfter(800, internal.tasks.settle, { taskId });
    await ctx.scheduler.runAfter(2_000, internal.commerce.deliver, { taskId, attempt: 0 });
    return { state: "paid" as const, token: null };
  },
});

/**
 * Checks a payment proof for the demo store: an on-chain transfer to the store (or a simulated
 * receipt) of at least the item's price when the payment was made. Prices move; a buyer who paid
 * the price they were quoted gets the item.
 */
export async function verifyProof(proof: PaymentProof, payTo: string, item: Doc<"storeItems">): Promise<{ ok: true; key: string; tx?: string } | { ok: false; why: string }> {
  if (proof.scheme !== SCHEME || proof.network !== NETWORK) return { ok: false, why: `Pay with scheme ${SCHEME} on ${NETWORK}` };
  if (proof.payload?.receipt) {
    const r = await checkReceipt(proof.payload.receipt, payTo);
    if (!r) return { ok: false, why: "Receipt doesn't check out" };
    if (r.at > Date.now() + 60_000 || r.at < Date.now() - 7 * DAY) return { ok: false, why: "Receipt is too old" };
    if (r.cents < priceAt(item, r.at)) return { ok: false, why: "Paid less than the price at the time" };
    return { ok: true, key: `r:${proof.payload.receipt.split(".")[0]}` };
  }
  const tx = proof.payload?.txHash;
  if (!tx || !/^0x[0-9a-fA-F]{64}$/.test(tx)) return { ok: false, why: "No transaction hash in X-PAYMENT" };
  const pub = createPublicClient({ chain: baseSepolia, transport: viemHttp(process.env.CHAIN_RPC_URL ?? "https://sepolia.base.org", { timeout: 15_000 }) });
  try {
    const receipt = await pub.getTransactionReceipt({ hash: tx as Hex });
    if (receipt.status !== "success") return { ok: false, why: "That transaction failed" };
    const logs = parseEventLogs({ abi: testUsdAbi, logs: receipt.logs.filter((l) => l.address.toLowerCase() === token().toLowerCase()), eventName: "Transfer" });
    const paid = logs.filter((l) => (l.args as { to: string }).to.toLowerCase() === payTo.toLowerCase()).reduce((s, l) => s + (l.args as { value: bigint }).value, 0n);
    const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
    const at = Number(block.timestamp) * 1000;
    if (at < Date.now() - 7 * DAY) return { ok: false, why: "That payment is too old" };
    // A held payment is decided before it settles: the lowest price in the hour before counts.
    const lowest = Math.min(priceAt(item, at), priceAt(item, at - 3600_000));
    if (paid < BigInt(lowest) * UNITS_PER_CENT) return { ok: false, why: "That transaction didn't pay this store enough" };
    return { ok: true, key: `t:${tx.toLowerCase()}`, tx };
  } catch {
    return { ok: false, why: "Couldn't find that transaction on Base Sepolia yet" };
  }
}

export function paymentRequired(url: string, row: Doc<"storeItems">) {
  return {
    x402Version: X402_VERSION,
    error: "X-PAYMENT header is required",
    accepts: [
      {
        scheme: SCHEME,
        network: NETWORK,
        maxAmountRequired: String(BigInt(row.priceMinor) * UNITS_PER_CENT),
        resource: url,
        description: row.name,
        mimeType: "application/json",
        payTo: storeAddress(),
        maxTimeoutSeconds: 3600,
        asset: token(),
        extra: { name: "tUSD", decimals: 6, settlement: "Send tUSD to payTo on Base Sepolia, then retry with X-PAYMENT carrying the transaction hash." },
      },
    ],
  };
}

export { unb64 };

/** For the web app's store page and tests: the catalog with current prices. */
export const catalog = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("storeItems").take(20);
    const by = new Map(rows.map((r) => [r.slug, r]));
    return ITEMS.map((i) => {
      const r = by.get(i.slug);
      return { slug: i.slug, name: i.name, emoji: i.emoji, category: i.category, blurb: i.blurb, priceMinor: r?.priceMinor ?? i.priceMinor, basePriceMinor: i.priceMinor };
    });
  },
});

/** The owner drops a demo price from the app to watch their agent buy (Agents → Purchases). */
export const dropPrice = mutation({
  args: { slug: v.string(), priceMinor: v.optional(v.number()) },
  handler: async (ctx, { slug, priceMinor }) => {
    await requireViewer(ctx);
    return await applyPrice(ctx, slug, priceMinor);
  },
});
