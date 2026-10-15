import { convert, decimalsOf } from "@agent-wallet/domain";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { latestRates } from "../rates";

const DAY = 86_400_000;

export type Overview = Awaited<ReturnType<typeof computeOverview>>;

/**
 * "Available after commitments": cash in the reporting currency, minus card dues,
 * bills due before next income, the emergency fund and pending card/UPI spends.
 * Every term is returned so the UI can show its working.
 */
export async function computeOverview(ctx: QueryCtx, user: Doc<"users">) {
  const now = Date.now();
  const rates = await latestRates(ctx);
  const to = (minor: number, from: Doc<"accounts">["currency"]) => convert(minor, from, user.currency, rates.fiat);
  const accounts = await ctx.db
    .query("accounts")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .take(100);
  const cashKinds = new Set(["bank", "payment_app", "cash", "transfer"]);
  const cash = accounts.filter((a) => cashKinds.has(a.kind)).reduce((s, a) => s + to(a.balanceMinor, a.currency), 0);
  const cardDue = accounts
    .filter((a) => a.kind === "card" && a.balanceMinor < 0)
    .reduce((s, a) => s - to(a.balanceMinor, a.currency), 0);
  const cryptoValue = accounts.filter((a) => a.kind === "crypto").reduce((s, a) => s + to(a.balanceMinor, a.currency), 0);
  const netWorth = accounts.reduce((s, a) => s + to(a.balanceMinor, a.currency), 0);

  const obligations = await ctx.db
    .query("obligations")
    .withIndex("by_user_due", (q) => q.eq("userId", user._id).gte("nextDueAt", now - DAY))
    .take(200);
  const active = obligations.filter((o) => o.status === "active");
  const beforeIncome = active.filter((o) => o.nextDueAt <= user.nextIncomeAt);
  const commitments = beforeIncome.reduce((s, o) => s + to(o.amountMinor, o.currency), 0);

  const recent = (
    await ctx.db
      .query("transactions")
      .withIndex("by_user_at", (q) => q.eq("userId", user._id).gte("at", now - 40 * DAY))
      .order("desc")
      .take(2000)
  ).filter((t) => !t.duplicateOf);
  const pending = recent
    .filter((t) => t.status === "pending" && t.amountMinor < 0 && t.kind !== "transfer")
    .reduce((s, t) => s - to(t.amountMinor, t.currency), 0);

  const monthStart = new Date(now);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const spentThisMonth = recent
    .filter((t) => t.at >= monthStart.getTime() && t.kind === "spend")
    .reduce((s, t) => s - to(t.amountMinor, t.currency), 0);

  const available = cash - cardDue - commitments - user.emergencyMinor - pending;
  const daysToIncome = Math.max(1, Math.ceil((user.nextIncomeAt - now) / DAY));

  const byCategory = new Map<string, number>();
  for (const t of recent) {
    if (t.kind !== "spend" || t.at < monthStart.getTime()) continue;
    byCategory.set(t.category, (byCategory.get(t.category) ?? 0) - to(t.amountMinor, t.currency));
  }

  const wallet = await ctx.db
    .query("wallets")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .unique();
  const agents = await ctx.db
    .query("agents")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .take(50);
  const liveAgents = agents.filter((a) => a.status === "active" && a.scopes.includes("spend"));
  const agentHeadroom = liveAgents.reduce((s, a) => s + Math.max(0, a.dailyCapMinor - a.spentTodayMinor), 0);
  const spentToday = agents.reduce((s, a) => s + a.spentTodayMinor, 0);
  // A live vault answers this itself (agentHeadroom, read back in chain.ts), capped by what the
  // agents it knows about may still spend.
  const vault = wallet?.status === "live" && wallet.version === 2 ? wallet.vault : undefined;
  const keyed = liveAgents.filter((a) => a.vault?.active && !a.vault.frozen);
  const agentAuthority = vault
    ? vault.frozen
      ? 0
      : Math.min(vault.headroomMinor, keyed.reduce((s, a) => s + Math.max(0, a.vault!.dailyCapMinor - a.vault!.spentMinor), 0))
    : wallet && !wallet.frozen
      ? Math.max(
          0,
          Math.min(
            agentHeadroom,
            wallet.dailyCeilingMinor - spentToday,
            wallet.balanceMinor - wallet.protectedMinor,
          ),
        )
      : 0;

  const unit = 10 ** decimalsOf(user.currency);
  const whole = (n: number) => Math.round(n / unit) * unit;
  return {
    currency: user.currency,
    available: Math.floor(available / unit) * unit,
    perDay: Math.floor(Math.max(0, available) / daysToIncome / unit) * unit,
    daysToIncome,
    cash: whole(cash),
    cardDue: whole(cardDue),
    commitments,
    commitmentCount: beforeIncome.length,
    emergency: user.emergencyMinor,
    pending,
    spentThisMonth,
    budget: user.monthlyBudgetMinor,
    categories: [...byCategory.entries()]
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount),
    oldestSync: accounts.length ? Math.min(...accounts.map((a) => a.syncedAt)) : now,
    netWorth: whole(netWorth),
    cryptoValue: whole(cryptoValue),
    accountCount: accounts.length,
    ratesDate: rates.date,
    suggested: obligations.filter((o) => o.status === "suggested").length,
    agentAuthority,
    walletCurrency: "USDC" as const,
    upcoming: active.slice(0, 5),
  };
}
