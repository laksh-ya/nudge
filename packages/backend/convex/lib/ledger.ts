import { categorize, merchantKey, normalizeMerchant, titleCase } from "@agent-wallet/domain";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

const DAY = 86_400_000;
const MAX_MINOR = 1e14;

export type IncomingRow = {
  at: number;
  amountMinor: number;
  description: string;
  balanceMinor?: number;
  pending?: boolean;
  category?: string;
  note?: string;
  receiptId?: Id<"_storage">;
};

export type IngestResult = { rows: number; added: number; duplicates: number; transfers: number; fromAt?: number; toAt?: number };

function validRow(r: IncomingRow) {
  return (
    Number.isFinite(r.at) &&
    r.at > Date.UTC(1990, 0, 1) &&
    r.at < Date.now() + 366 * DAY &&
    Number.isSafeInteger(r.amountMinor) &&
    r.amountMinor !== 0 &&
    Math.abs(r.amountMinor) < MAX_MINOR &&
    (r.balanceMinor === undefined || (Number.isSafeInteger(r.balanceMinor) && Math.abs(r.balanceMinor) < MAX_MINOR))
  );
}

/**
 * Add rows to one account's ledger.
 * - Re-importing the same rows into the same account is a no-op.
 * - The same spend seen through another source (bank + UPI app + receipt) is kept but marked as a duplicate.
 * - Matching money out of one own account and into another becomes a transfer, not income or spend.
 */
export async function ingest(
  ctx: MutationCtx,
  user: Doc<"users">,
  account: Doc<"accounts">,
  incoming: IncomingRow[],
  importId: Id<"imports"> | undefined,
): Promise<IngestResult> {
  const rows = incoming.filter(validRow).sort((a, b) => a.at - b.at);
  if (rows.length === 0) return { rows: 0, added: 0, duplicates: 0, transfers: 0 };
  const fromAt = rows[0]!.at;
  const toAt = rows[rows.length - 1]!.at;

  const window = await ctx.db
    .query("transactions")
    .withIndex("by_user_at", (q) => q.eq("userId", user._id).gte("at", fromAt - 3 * DAY).lte("at", toAt + 3 * DAY))
    .take(8000);
  const fingerprints = new Set(window.map((t) => t.fingerprint).filter(Boolean));
  const accounts = await ctx.db.query("accounts").withIndex("by_user", (q) => q.eq("userId", user._id)).take(200);
  const accountKind = new Map(accounts.map((a) => [a._id, a.kind]));
  const rules = new Map(
    (await ctx.db.query("rules").withIndex("by_user_key", (q) => q.eq("userId", user._id)).take(500)).map((r) => [r.key, r.category]),
  );

  let added = 0;
  let duplicates = 0;
  const seen = new Map<string, number>();
  const fresh: Doc<"transactions">[] = [];

  for (const r of rows) {
    const merchant = titleCase(normalizeMerchant(r.description));
    const key = merchantKey(r.description);
    const day = Math.floor(r.at / DAY);
    // Two identical rows on one day in one statement are both real; number them.
    const base = `${account._id}|${day}|${r.amountMinor}|${key}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const fingerprint = `${base}|${n}`;
    if (fingerprints.has(fingerprint)) {
      duplicates++;
      continue;
    }
    const twin = window.find(
      (t) =>
        t.accountId !== account._id &&
        !t.duplicateOf &&
        !t.pairId &&
        t.currency === account.currency &&
        t.amountMinor === r.amountMinor &&
        Math.abs(t.at - r.at) <= 2 * DAY &&
        // Two banks or cards don't report each other's spends. The same spend shows up twice only
        // when a payment app or a receipt is one of the sources.
        (accountKind.get(t.accountId) === "payment_app" ||
          account.kind === "payment_app" ||
          r.receiptId !== undefined ||
          t.receiptId !== undefined ||
          account.kind === "cash" && merchantKey(t.merchant) === key),
    );
    const category = r.category ?? rules.get(key) ?? categorize(merchant, r.amountMinor);
    const id = await ctx.db.insert("transactions", {
      userId: user._id,
      accountId: account._id,
      at: r.at,
      amountMinor: r.amountMinor,
      currency: account.currency,
      merchant,
      category,
      status: r.pending ? "pending" : "posted",
      kind: category === "Transfer" ? "transfer" : r.amountMinor > 0 ? (category === "Income" ? "income" : "refund") : "spend",
      importId,
      fingerprint,
      duplicateOf: twin?._id,
      note: r.note,
      receiptId: r.receiptId,
      categoryLocked: r.category !== undefined ? true : undefined,
      raw: r.description.slice(0, 160),
    });
    fingerprints.add(fingerprint);
    if (twin) duplicates++;
    else added++;
    const doc = (await ctx.db.get(id))!;
    fresh.push(doc);
    window.push(doc);
  }

  const transfers = await matchTransfers(ctx, window, fresh);

  // Balance: trust the statement's running balance when it has one.
  const withBalance = rows.filter((r) => r.balanceMinor !== undefined);
  if (withBalance.length > 0) {
    const latest = withBalance[withBalance.length - 1]!;
    if (latest.at >= account.syncedAt - DAY || account.status === "empty") {
      await ctx.db.patch(account._id, { balanceMinor: latest.balanceMinor! });
    }
  } else if (account.kind !== "crypto") {
    const net = fresh.filter((t) => !t.duplicateOf).reduce((s, t) => s + t.amountMinor, 0);
    await ctx.db.patch(account._id, { balanceMinor: account.balanceMinor + net });
  }
  await ctx.db.patch(account._id, { syncedAt: Date.now(), status: "ok", statusNote: undefined });

  await detectRecurring(ctx, user);
  return { rows: rows.length, added, duplicates, transfers, fromAt, toAt };
}

async function matchTransfers(ctx: MutationCtx, window: Doc<"transactions">[], fresh: Doc<"transactions">[]) {
  let pairs = 0;
  const used = new Set<string>();
  for (const t of fresh) {
    if (t.duplicateOf || t.pairId || used.has(t._id)) continue;
    const other = window.find(
      (o) =>
        o._id !== t._id &&
        !used.has(o._id) &&
        !o.pairId &&
        !o.duplicateOf &&
        o.accountId !== t.accountId &&
        o.currency === t.currency &&
        o.amountMinor === -t.amountMinor &&
        Math.abs(o.at - t.at) <= 3 * DAY,
    );
    if (!other) continue;
    const pairId = `${t._id}:${other._id}`;
    for (const doc of [t, other]) {
      if (!doc.categoryLocked) await ctx.db.patch(doc._id, { kind: "transfer", category: "Transfer", pairId });
      else await ctx.db.patch(doc._id, { kind: "transfer", pairId });
      used.add(doc._id);
    }
    pairs++;
  }
  return pairs;
}

const CADENCE = [
  { cadence: "weekly" as const, min: 6, max: 8, days: 7 },
  { cadence: "monthly" as const, min: 26, max: 35, days: 30 },
  { cadence: "yearly" as const, min: 350, max: 380, days: 365 },
];

function addCadence(at: number, cadence: "weekly" | "monthly" | "yearly") {
  const d = new Date(at);
  if (cadence === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  if (cadence === "monthly") d.setUTCMonth(d.getUTCMonth() + 1);
  if (cadence === "yearly") d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.getTime();
}

/**
 * Find payments that repeat on a schedule and propose them as bills or subscriptions.
 * Suggestions wait for the user; dismissed ones never come back. A monthly salary sets payday.
 */
export async function detectRecurring(ctx: MutationCtx, user: Doc<"users">) {
  const since = Date.now() - 400 * DAY;
  const txs = await ctx.db
    .query("transactions")
    .withIndex("by_user_at", (q) => q.eq("userId", user._id).gte("at", since))
    .take(8000);
  const groups = new Map<string, Doc<"transactions">[]>();
  for (const t of txs) {
    if (t.duplicateOf || t.kind === "transfer" || t.category === "Transfer" || (t.currency !== user.currency && t.kind === "income")) continue;
    const key = merchantKey(t.merchant);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }
  const existing = await ctx.db
    .query("obligations")
    .withIndex("by_user_due", (q) => q.eq("userId", user._id))
    .take(500);
  const byKey = new Map(existing.filter((o) => o.merchantKey).map((o) => [o.merchantKey!, o]));
  const byName = new Map(existing.map((o) => [merchantKey(o.name), o]));

  let bestIncome: { amount: number; next: number; day: number } | null = null;

  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.at - b.at);
    const gaps = list.slice(1).map((t, i) => (t.at - list[i]!.at) / DAY);
    const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!;
    const rule = CADENCE.find((c) => median >= c.min && median <= c.max);
    if (!rule) continue;
    if (gaps.some((g) => g < rule.min * 0.6)) continue;
    const amounts = list.map((t) => Math.abs(t.amountMinor));
    const spread = Math.max(...amounts) / Math.min(...amounts);
    if (spread > 1.4) continue;
    if (list.length < 3 && spread > 1.05) continue;
    const last = list[list.length - 1]!;
    const prev = list[list.length - 2]!;
    const next = addCadence(last.at, rule.cadence);
    if (next < Date.now() - 10 * DAY) continue;

    if (last.amountMinor > 0) {
      if (last.category === "Income" && rule.cadence === "monthly" && (!bestIncome || last.amountMinor > bestIncome.amount)) {
        bestIncome = { amount: last.amountMinor, next, day: new Date(last.at).getUTCDate() };
      }
      continue;
    }

    const amount = Math.abs(last.amountMinor);
    const prevAmount = Math.abs(prev.amountMinor);
    const rose = amount > prevAmount * 1.02 ? prevAmount : undefined;
    const kind = last.category === "Subscriptions" || (amount < 300_000 && last.category !== "Bills" && last.category !== "Rent") ? "subscription" : "bill";
    const found = byKey.get(key) ?? byName.get(key);
    if (found) {
      if (found.status === "dismissed" || found.status === "cancelled") continue;
      if (found.source === "detected" || found.status === "suggested") {
        await ctx.db.patch(found._id, {
          amountMinor: amount,
          previousAmountMinor: rose ?? found.previousAmountMinor,
          nextDueAt: Math.max(found.nextDueAt, next),
          occurrences: list.length,
          lastPaidAt: last.at,
        });
      } else if (found.nextDueAt < last.at + DAY && last.at > found.nextDueAt - 5 * DAY) {
        // A manual bill that has just been paid moves to its next date.
        await ctx.db.patch(found._id, { nextDueAt: addCadence(found.nextDueAt, found.cadence), lastPaidAt: last.at });
      }
      continue;
    }
    await ctx.db.insert("obligations", {
      userId: user._id,
      name: last.merchant,
      kind,
      amountMinor: amount,
      previousAmountMinor: rose,
      currency: last.currency,
      cadence: rule.cadence,
      nextDueAt: next,
      status: "suggested",
      merchantKey: key,
      source: "detected",
      occurrences: list.length,
      lastPaidAt: last.at,
      accountId: last.accountId,
    });
  }

  if (bestIncome) {
    await ctx.db.patch(user._id, { nextIncomeAt: bestIncome.next, incomeDay: bestIncome.day });
  }
}
