import { ConvexError } from "convex/values";
import { convert, decimalsOf, formatMoney, type Currency } from "@agent-wallet/domain";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { latestRates } from "../rates";
import { matchCategory, matchContacts, normalize, parsePeriod } from "./intent";
import { DAY, dateLabel, local, safeTz, whenWords } from "./schedule";

/**
 * Answers the assistant gives from the owner's own data: spending by category and period, goals,
 * reminders and payment status. Shared by the rule-based replies and the model's tools, so both say
 * the same numbers, and every figure is read here rather than written by a model.
 */

const MAX_ROWS = 5000;

export async function spendingSummary(ctx: QueryCtx, user: Doc<"users">, text: string, now = Date.now()) {
  const period = parsePeriod(text, now);
  const rates = await latestRates(ctx);
  const unconverted = new Set<string>();
  const to = (minor: number, from: Currency) => {
    try {
      return convert(minor, from, user.currency, rates.fiat);
    } catch {
      unconverted.add(from);
      return 0;
    }
  };
  const rows: Doc<"transactions">[] = [];
  let partial = false;
  for await (const r of ctx.db
    .query("transactions")
    .withIndex("by_user_at", (q) => q.eq("userId", user._id).gte("at", period.from).lt("at", period.to))
    .order("desc")) {
    if (rows.length === MAX_ROWS) {
      partial = true;
      break;
    }
    rows.push(r);
  }
  const spends = rows.filter((t) => t.kind === "spend" && !t.duplicateOf);
  // Categories this owner actually uses, so "food" finds "Food" and "eating out" does too.
  const vocab = new Set(spends.map((t) => t.category));
  const recent = await ctx.db
    .query("transactions")
    .withIndex("by_user_at", (q) => q.eq("userId", user._id).gte("at", now - 400 * DAY))
    .order("desc")
    .take(1000);
  for (const t of recent) vocab.add(t.category);
  const category = matchCategory(text, [...vocab]);
  let merchant: string | null = null;
  if (!category) {
    const t = ` ${normalize(text)} `;
    const names = [...new Set([...spends, ...recent].map((r) => r.merchant))];
    const hit = names
      .map((n) => ({ n, w: normalize(n).split(/[^\p{L}\p{N}]+/u).find((w) => w.length >= 4 && t.includes(` ${w} `)) }))
      .find((x) => x.w);
    merchant = hit?.w ?? null;
  }
  const chosen = spends.filter((t) =>
    category ? normalize(t.category) === normalize(category) : merchant ? normalize(t.merchant).includes(merchant) : true,
  );
  const amount = (t: Doc<"transactions">) => -to(t.amountMinor, t.currency);
  const total = chosen.reduce((s, t) => s + amount(t), 0);
  const biggest = chosen.reduce<Doc<"transactions"> | null>((b, t) => (!b || amount(t) > amount(b) ? t : b), null);
  const byCategory = new Map<string, number>();
  for (const t of chosen) byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + amount(t));
  return {
    period,
    category,
    merchant,
    currency: user.currency,
    totalMinor: total,
    count: chosen.length,
    biggest: biggest ? { merchant: biggest.merchant, amountMinor: amount(biggest), at: biggest.at } : null,
    byCategory: [...byCategory.entries()].map(([name, amountMinor]) => ({ name, amountMinor })).sort((a, b) => b.amountMinor - a.amountMinor),
    unconverted: [...unconverted],
    partial,
  };
}

export function spendingSentence(s: Awaited<ReturnType<typeof spendingSummary>>) {
  const money = (n: number) => formatMoney(n, s.currency);
  const what = s.category ? ` on ${s.category}` : s.merchant ? ` at ${s.merchant.charAt(0).toUpperCase()}${s.merchant.slice(1)}` : "";
  const notes = [s.unconverted.length ? `Amounts in ${s.unconverted.join(", ")} have no exchange rate today and are left out.` : "", s.partial ? "That's a partial total: there are more transactions than I can read at once." : ""]
    .filter(Boolean)
    .join(" ");
  if (s.count === 0) return `I don't see any spending${what} ${s.period.label}.${notes ? ` ${notes}` : ""}`;
  const parts = [`You spent ${money(s.totalMinor)}${what} ${s.period.label}, across ${s.count} ${s.count === 1 ? "payment" : "payments"}.`];
  if (s.biggest && s.count > 1) parts.push(`Biggest: ${s.biggest.merchant} ${money(s.biggest.amountMinor)}.`);
  if (!s.category && !s.merchant && s.byCategory.length > 1) {
    parts.push(`Top: ${s.byCategory.slice(0, 3).map((c) => `${c.name} ${money(c.amountMinor)}`).join(", ")}.`);
  }
  if (notes) parts.push(notes);
  return parts.join(" ");
}

export function unitOf(currency: Currency) {
  return 10 ** decimalsOf(currency);
}

/** Months left until a goal's date, at least one, and what to put aside each month. */
export function goalPlan(goal: { targetMinor: number; savedMinor: number; currency: Currency; dueAt?: number }, now = Date.now()) {
  const remaining = Math.max(0, goal.targetMinor - goal.savedMinor);
  if (!goal.dueAt) return { remaining, months: null, monthly: null };
  const months = Math.max(1, Math.ceil((goal.dueAt - now) / (30.44 * DAY)));
  const unit = unitOf(goal.currency);
  return { remaining, months, monthly: Math.ceil(remaining / months / unit) * unit };
}

export function goalLine(g: Doc<"goals">, tz: string, now = Date.now()) {
  const money = (n: number) => formatMoney(n, g.currency);
  const pct = g.targetMinor ? Math.min(100, Math.floor((g.savedMinor / g.targetMinor) * 100)) : 0;
  const plan = goalPlan(g, now);
  let line = `${g.name}: ${money(g.savedMinor)} of ${money(g.targetMinor)} saved (${pct}%)`;
  if (plan.remaining === 0) line += ". Reached!";
  else if (g.dueAt && g.dueAt < now) line += `, ${money(plan.remaining)} to go; the date (${dateLabel(g.dueAt, tz)}) has passed`;
  else if (plan.monthly !== null) line += `, ${money(plan.monthly)} a month to reach it by ${dateLabel(g.dueAt!, tz)}`;
  else line += `, ${money(plan.remaining)} to go`;
  return line;
}

export async function findGoal(ctx: QueryCtx, userId: Id<"users">, name: string | null) {
  const goals = await ctx.db.query("goals").withIndex("by_user", (q) => q.eq("userId", userId)).take(50);
  if (!name) return { goals, match: null };
  const hits = matchContacts(name, goals);
  return { goals, match: hits.length === 1 ? hits[0]! : null };
}

export function titleCase(s: string) {
  const clean = s.trim().replace(/\s+/g, " ").slice(0, 40);
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** Create a goal, or move an existing one's target and date. Planning only: no money moves. */
export async function saveGoal(ctx: MutationCtx, user: Doc<"users">, g: { goalId?: Id<"goals">; name: string; targetMinor: number; currency: Currency; dueAt?: number }) {
  if (!Number.isSafeInteger(g.targetMinor) || g.targetMinor <= 0 || g.targetMinor > 1e13) throw new ConvexError("Amount is out of range");
  if (g.goalId) {
    const goal = await ctx.db.get(g.goalId);
    if (goal && goal.userId === user._id) {
      await ctx.db.patch(goal._id, { targetMinor: g.targetMinor, currency: g.currency, ...(g.dueAt ? { dueAt: g.dueAt } : {}) });
      return { goalId: goal._id, created: false };
    }
  }
  const icon = /trip|travel|holiday|vacation|goa/i.test(g.name) ? "palmtree" : /laptop|computer|phone/i.test(g.name) ? "laptop" : "piggy-bank";
  const goalId = await ctx.db.insert("goals", { userId: user._id, name: titleCase(g.name), icon, targetMinor: g.targetMinor, savedMinor: 0, currency: g.currency, dueAt: g.dueAt });
  await ctx.db.insert("activity", { userId: user._id, kind: "setting", title: `New goal: ${titleCase(g.name)}`, detail: "Set in chat", tone: "neutral" });
  return { goalId, created: true };
}

/** Whether a bill or subscription is named in the text ("rent", "the electricity bill"). */
export function matchBill<T extends { name: string }>(text: string, bills: T[]) {
  const aliases: Record<string, string> = { electricity: "bescom", power: "bescom", phone: "airtel", landlord: "rent", internet: "airtel" };
  const words = Object.entries(aliases).reduce((s, [k, v]) => (new RegExp(`\\b${k}\\b`).test(s) ? `${s} ${v}` : s), normalize(text));
  return matchContacts(words, bills);
}

const DATE_CUE =
  /\s+(?:(?:on|by|every|each)\s+(?:the\s+)?(?:\d+(?:st|nd|rd|th)?|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|at\s+\d|in\s+(?:\d+|a|an|one|two|three)\s+(?:min|hour|hr|day|week|month)|next\s+(?:week|month|mon|tue|wed|thu|fri|sat|sun)|this\s+(?:evening|afternoon|morning|week|month)|tomorrow|today|tonight|monthly|weekly|before\s+(?:it'?s\s+)?due)\b/;

/** What to be reminded of: "remind me to pay rent on the 1st" → "Pay rent". */
export function reminderWhat(text: string) {
  const t = normalize(text);
  const body = t.replace(/^.*?\bremind(?:er)?\s+(?:me\s+)?(?:to\s+|about\s+|of\s+|that\s+|for\s+)?/, "");
  const cut = body.search(DATE_CUE);
  const what = (cut >= 0 ? body.slice(0, cut) : body).replace(/[.!?,\s]+$/, "").trim();
  return what ? titleCase(what) : "";
}

export async function createReminder(
  ctx: MutationCtx,
  user: Doc<"users">,
  r: { text: string; dueAt: number; repeat?: "monthly" | "weekly"; obligationId?: Id<"obligations"> },
) {
  const open = await ctx.db.query("reminders").withIndex("by_user", (q) => q.eq("userId", user._id).eq("status", "scheduled")).take(101);
  if (open.length >= 100) throw new ConvexError("You have 100 reminders waiting. Cancel some first.");
  return await ctx.db.insert("reminders", { userId: user._id, text: r.text.slice(0, 140), dueAt: r.dueAt, repeat: r.repeat, repeatDay: r.repeat === "monthly" ? local(r.dueAt, safeTz(user.timezone)).day : undefined, obligationId: r.obligationId, status: "scheduled" });
}

export async function telegramLinked(ctx: QueryCtx, userId: Id<"users">) {
  const links = await ctx.db.query("chatLinks").withIndex("by_user", (q) => q.eq("userId", userId)).take(5);
  return links.some((l) => l.channel === "telegram" && l.linkedAt && l.externalId);
}

/** Reminders go to Telegram too when it is linked, unless the owner chose the app only. */
export function wantsTelegram(user: Doc<"users">) {
  return user.reminderChannel !== "app";
}

const STATE_WORDS: Record<Doc<"tasks">["state"], string> = {
  drafted: "a draft, not sent",
  needs_info: "waiting for details",
  checked: "checked, not sent yet",
  awaiting_approval: "waiting for your approval",
  reserved: "being sent",
  submitted: "on its way",
  confirmed: "paid",
  failed: "failed",
  cancelled: "cancelled",
  expired: "expired without approval",
  unknown: "sent, but I haven't seen the receipt yet; it settles from the chain",
  queued: "waiting out the vault's delay",
  held: "held so you can still cancel it",
  reported: "marked paid by you (your bank hasn't confirmed it)",
};

export function describeTask(task: Doc<"tasks">, payee: string | undefined, tz: string, now = Date.now()) {
  const amount = task.amountMinor !== undefined ? formatMoney(task.amountMinor, task.currency ?? "USDC") : "";
  const who = payee ? ` to ${payee}` : "";
  let state = STATE_WORDS[task.state];
  if (task.state === "held" && task.releaseAt) state += ` until ${dateLabel(task.releaseAt, safeTz(tz), true)}`;
  if ((task.state === "failed" || task.state === "cancelled") && task.reason) state += `: ${task.reason}`;
  const sim = task.rail === "simulator" && ["confirmed", "submitted"].includes(task.state) ? " (simulated)" : "";
  const tx = task.txHash ? ` Transaction: https://sepolia.basescan.org/tx/${task.txHash}` : "";
  const when = task.state === "awaiting_approval" && task.expiresAt ? ` It expires ${whenWords(task.expiresAt, now, tz) === "today" ? `at ${dateLabel(task.expiresAt, tz, true).split(" at ")[1]}` : whenWords(task.expiresAt, now, tz)}.` : "";
  return `The ${amount} payment${who} is ${state}${sim}.${when}${tx}`.replace(/\s+/g, " ").replace("The  payment", "The payment");
}

/** Payment states chat may still replace or cancel: nothing has left the wallet yet. */
export const OPEN_STATES = new Set<Doc<"tasks">["state"]>(["drafted", "needs_info", "checked", "awaiting_approval"]);
