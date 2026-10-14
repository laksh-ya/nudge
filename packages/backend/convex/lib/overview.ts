import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

const DAY = 86_400_000;

export type Overview = Awaited<ReturnType<typeof computeOverview>>;

/**
 * "Available after commitments": cash in the reporting currency, minus card dues,
 * bills due before next income, the emergency fund and pending card/UPI spends.
 * Every term is returned so the UI can show its working.
 */
export async function computeOverview(ctx: QueryCtx, user: Doc<"users">) {
  const now = Date.now();
  const accounts = await ctx.db
    .query("accounts")
    .withIndex("by_user", (q) => q.eq("userId", user._id))
    .take(50);
  const inCurrency = accounts.filter((a) => a.currency === user.currency);
  const cash = inCurrency.filter((a) => a.kind !== "card").reduce((s, a) => s + a.balanceMinor, 0);
  const cardDue = inCurrency
    .filter((a) => a.kind === "card" && a.balanceMinor < 0)
    .reduce((s, a) => s - a.balanceMinor, 0);

  const obligations = await ctx.db
    .query("obligations")
    .withIndex("by_user_due", (q) => q.eq("userId", user._id).gte("nextDueAt", now - DAY))
    .take(100);
  const active = obligations.filter((o) => o.status === "active");
  const beforeIncome = active.filter((o) => o.nextDueAt <= user.nextIncomeAt && o.currency === user.currency);
  const commitments = beforeIncome.reduce((s, o) => s + o.amountMinor, 0);

  const recent = await ctx.db
    .query("transactions")
    .withIndex("by_user_at", (q) => q.eq("userId", user._id).gte("at", now - 40 * DAY))
    .order("desc")
    .take(500);
  const pending = recent
    .filter((t) => t.status === "pending" && t.amountMinor < 0 && t.currency === user.currency)
    .reduce((s, t) => s - t.amountMinor, 0);

  const monthStart = new Date(now);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const spentThisMonth = recent
    .filter((t) => t.at >= monthStart.getTime() && t.kind === "spend" && t.currency === user.currency)
    .reduce((s, t) => s - t.amountMinor, 0);

  const available = cash - cardDue - commitments - user.emergencyMinor - pending;
  const daysToIncome = Math.max(1, Math.ceil((user.nextIncomeAt - now) / DAY));

  const byCategory = new Map<string, number>();
  for (const t of recent) {
    if (t.kind !== "spend" || t.at < monthStart.getTime()) continue;
    byCategory.set(t.category, (byCategory.get(t.category) ?? 0) - t.amountMinor);
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
  const agentAuthority =
    wallet && !wallet.frozen
      ? Math.max(
          0,
          Math.min(
            agentHeadroom,
            wallet.dailyCeilingMinor - spentToday,
            wallet.balanceMinor - wallet.protectedMinor,
          ),
        )
      : 0;

  return {
    currency: user.currency,
    available: Math.floor(available / 100) * 100,
    perDay: Math.floor(Math.max(0, available) / daysToIncome / 100) * 100,
    daysToIncome,
    cash,
    cardDue,
    commitments,
    commitmentCount: beforeIncome.length,
    emergency: user.emergencyMinor,
    pending,
    spentThisMonth,
    budget: user.monthlyBudgetMinor,
    categories: [...byCategory.entries()]
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount),
    oldestSync: Math.min(...accounts.map((a) => a.syncedAt)),
    agentAuthority,
    walletCurrency: "USDC" as const,
    upcoming: active.slice(0, 5),
  };
}
