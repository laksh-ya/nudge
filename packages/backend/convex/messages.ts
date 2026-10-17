import { v, type Infer } from "convex/values";
import { convert, formatMoney, toMinor, type Currency } from "@agent-wallet/domain";
import { freezeAgent, freezeAll } from "./lib/control";
import { propose } from "./gateway";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireViewer, viewer } from "./lib/auth";
import { computeOverview } from "./lib/overview";
import { newApprovalToken } from "./lib/seed";
import { ownerPayTask, unfreezeTask } from "./lib/actions";
import { withNames } from "./tasks";
import { spendAssistantTurn } from "./lib/budget";
import { latestRates } from "./rates";
import { isVaultVersion } from "@agent-wallet/domain";
import type { chatDraft, pendingOffer } from "./schema";
import {
  amounts,
  classify,
  currencyWord,
  isStrictTail,
  matchContacts,
  normalize,
  ordinal,
  payeeWords,
  pickAmount,
  type Cur,
  type Intent,
} from "./lib/intent";
import {
  OPEN_STATES,
  createReminder,
  describeTask,
  findGoal,
  goalLine,
  goalPlan,
  matchBill,
  reminderWhat,
  saveGoal,
  spendingSentence,
  spendingSummary,
  telegramLinked,
  titleCase,
  unitOf,
  wantsTelegram,
} from "./lib/assist";
import { DAY, MINUTE, dateLabel, inQuietHours, local, parseDeadline, parseRepeat, parseWhen, safeTz, whenWords, zoned } from "./lib/schedule";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return [];
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(60);
    return await Promise.all(
      messages.reverse().map(async (m) => {
        const task = m.taskId ? await ctx.db.get(m.taskId) : null;
        return { ...m, task: task ? await withNames(ctx, task) : null };
      }),
    );
  },
});

export const send = mutation({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    const user = await requireViewer(ctx);
    const clean = text.trim().slice(0, 500);
    if (!clean) return;
    await ctx.db.insert("messages", { userId: user._id, role: "user", text: clean, channel: "app" });
    const useModel = await spendAssistantTurn(ctx, user);
    await ctx.scheduler.runAfter(0, internal.assistant.respond, { userId: user._id, text: clean, useModel });
  },
});

/** What the basic assistant can do, said when it doesn't understand. */
export const HELP =
  "I can tell you what's safe to spend, show spending by category and month, list bills and subscriptions that are due, pay a saved contact, check a payment, set reminders, track savings goals, and freeze or unfreeze your agents.";
const HELP_CHIPS = ["What can I spend?", "Food spending last month", "Bills due this week", "Remind me to pay rent on the 1st"];
/** A question or offer stays open this long; after that a short answer starts fresh. */
const OPEN_FOR = 30 * MINUTE;

type Pending = Infer<typeof pendingOffer>;
type Draft = Infer<typeof chatDraft>;
type Channel = "app" | "telegram";

type Turn = {
  ctx: MutationCtx;
  user: Doc<"users">;
  text: string;
  channel: Channel;
  tz: string;
  now: number;
  mode?: "basic" | "model";
  fallback?: string;
  payees: Doc<"payees">[];
  /** The question the last reply asked, if it is still open. */
  pending: Pending | null;
  /** The last payment chat proposed, and its task, if still recent. */
  draft: { draft: Draft; task: Doc<"tasks"> | null } | null;
};

async function say(turn: Turn, reply: string, extra: { taskId?: Id<"tasks">; suggestions?: string[]; pending?: Pending; draft?: Draft } = {}) {
  const { ctx, user, channel } = turn;
  // When the model failed mid-conversation, say so: the owner expected the full assistant.
  if (turn.fallback?.startsWith("api_error")) reply = `Basic mode (the AI model didn't answer): ${reply}`;
  await ctx.db.insert("messages", {
    userId: user._id,
    role: "assistant",
    text: reply,
    channel,
    taskId: extra.taskId,
    mode: turn.mode,
    fallback: turn.fallback,
    suggestions: extra.suggestions?.length ? extra.suggestions.slice(0, 4) : undefined,
    pending: extra.pending,
    draft: extra.draft,
  });
  if (channel === "telegram") {
    const task = extra.taskId ? await ctx.db.get(extra.taskId) : null;
    const base = process.env.APPROVE_URL ?? "https://agent-wallet-approve.vercel.app";
    await ctx.scheduler.runAfter(0, internal.telegram.send, {
      userId: user._id,
      text: reply,
      approvalUrl: task?.approvalToken ? `${base}/a/${task.approvalToken}` : undefined,
    });
  }
}

const money = (minor: number, currency: Currency) => formatMoney(minor, currency);
const walletCur = (cur: Cur, user: Doc<"users">): Currency => (cur === "USD" ? "USDC" : user.currency);

async function createPayment(ctx: MutationCtx, user: Doc<"users">, payee: Doc<"payees">, amountMinor: number, currency: Currency, title: string, channel: Channel) {
  if (currency === "USDC") {
    const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    if (wallet?.status === "live") {
      const { taskId } = await ownerPayTask(ctx, { user, payee, amountMinor, title, channel, reason: "You're paying from your agent wallet" });
      return taskId;
    }
  }
  return await ctx.db.insert("tasks", {
    userId: user._id,
    title,
    channel,
    payeeId: payee._id,
    amountMinor,
    currency,
    state: "awaiting_approval",
    reason: currency === "USDC" ? "New request from chat" : "Bank payments need your approval",
    rail: currency === "USDC" ? "simulator" : "handoff",
    approvalToken: newApprovalToken(),
    expiresAt: Date.now() + 30 * 60_000,
    updatedAt: Date.now(),
  });
}

/** A replaced or cancelled request can never be approved: its approval link stops working. */
async function closeTask(ctx: MutationCtx, task: Doc<"tasks">, reason: string) {
  await ctx.db.patch(task._id, { state: "cancelled", reason, approvalToken: undefined, updatedAt: Date.now() });
  await ctx.db.insert("activity", { userId: task.userId, kind: "payment", title: `${task.title}: ${reason}`, tone: "neutral" });
}

/**
 * The whole payment conversation. Asks for whatever is missing (who, how much, which money) one
 * thing at a time; then dollars go through the same gateway decision any agent gets. Only a short,
 * direct order in the owner's own words may pay without a card (#59); everything else gets one.
 */
async function pay(
  turn: Turn,
  r: { payees: Doc<"payees">[]; payeeText?: string | null; amountMajor?: number; cur?: Cur | null; reason?: string; direct: boolean; replaces?: Doc<"tasks"> | null; instead?: number | null },
) {
  const { ctx, user } = turn;
  // Revoke the old approval immediately, even if the replacement still needs clarification.
  if (r.replaces && OPEN_STATES.has(r.replaces.state)) {
    await closeTask(ctx, r.replaces, "Superseded by a correction in chat");
  }
  const base = { reason: r.reason, direct: r.direct, replaces: r.replaces?._id };
  const amountPart = r.amountMajor !== undefined ? { amountMajor: r.amountMajor } : {};
  const curPart = r.cur ? { cur: r.cur } : {};
  if (r.payees.length === 0) {
    const names = turn.payees.map((p) => p.name);
    const who = r.payeeText ? titleCase(r.payeeText) : "That person";
    return say(
      turn,
      names.length
        ? `${who} isn't one of your saved contacts, and I can only pay saved contacts. Add them in Wallet → Contacts first, or pick one: ${names.slice(0, 6).join(", ")}.`
        : "You don't have any saved contacts yet, and I can only pay saved contacts. Add one in Wallet → Contacts first.",
      { suggestions: names.slice(0, 4), pending: names.length ? { kind: "pay", missing: "payee", payeeIds: turn.payees.slice(0, 12).map((p) => p._id), ...amountPart, ...curPart, ...base, direct: false } : undefined },
    );
  }
  if (r.payees.length > 1) {
    const names = r.payees.slice(0, 4).map((p) => p.name);
    const word = r.payeeText ? titleCase(r.payeeText.split(" ")[0]!) : "contact";
    return say(turn, `Which ${word}: ${names.slice(0, -1).join(", ")} or ${names.at(-1)}?`, {
      suggestions: names,
      pending: { kind: "pay", missing: "payee", payeeIds: r.payees.slice(0, 4).map((p) => p._id), ...amountPart, ...curPart, ...base },
    });
  }
  const payee = r.payees[0]!;
  if (r.amountMajor === undefined) {
    return say(turn, `How much should I send ${payee.name}?`, { pending: { kind: "pay", missing: "amount", payeeIds: [payee._id], ...curPart, ...base } });
  }
  let cur = r.cur ?? null;
  if (!cur) {
    // A biller's bill says which money it's in; otherwise ask rather than guess.
    const bill = (await ctx.db.query("obligations").withIndex("by_user_due", (q) => q.eq("userId", user._id)).take(100)).find((o) => o.payeeId === payee._id && o.status === "active");
    if (bill) cur = bill.currency === "USDC" || bill.currency === "USD" ? "USD" : "LOCAL";
  }
  if (!cur) {
    const usd = money(Math.round(r.amountMajor * 100), "USDC");
    const loc = money(toMinor(r.amountMajor, user.currency), user.currency);
    return say(turn, `Is that ${usd} from the agent wallet (test dollars), or ${loc} from your bank by UPI?`, {
      suggestions: [`${usd} from the agent wallet`, `${loc} by UPI`],
      pending: { kind: "pay", missing: "currency", payeeIds: [payee._id], amountMajor: r.amountMajor, ...base },
    });
  }

  if (!Number.isFinite(r.amountMajor) || r.amountMajor <= 0 || !Number.isSafeInteger(Math.round(r.amountMajor * 100)) || r.amountMajor > 1e9) {
    return say(turn, "That amount is out of range. Tell me a positive amount with its currency.");
  }
  const currency = walletCur(cur, user);
  const minor = toMinor(r.amountMajor, currency);
  const label = money(minor, currency);
  let replaced = "";
  if (r.replaces) {
    if (OPEN_STATES.has(r.replaces.state)) {
      const old = r.replaces.amountMinor !== undefined ? money(r.replaces.amountMinor, r.replaces.currency ?? "USDC") : "earlier";
      replaced = ` The ${old} request is cancelled and can't be approved.`;
    }
  } else if (r.instead !== undefined && r.instead !== null && r.instead !== r.amountMajor) {
    replaced = ` Not ${money(toMinor(r.instead, currency), currency)}: nothing was set up for that.`;
  }
  const draft: Draft = { payeeId: payee._id, amountMajor: r.amountMajor, cur, reason: r.reason, direct: r.direct };
  const title = r.reason ? `Pay ${payee.name} for ${r.reason}` : `Pay ${payee.name}`;

  if (cur === "USD") {
    // Dollars come from the agent wallet: the assistant gets the same decision any agent gets,
    // so inside its limits it pays, above them it asks you, and the vault has the last word.
    const own = r.direct
      ? (await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50)).find((x) => x.provider === "own" && x.status === "active")
      : undefined;
    if (own) {
      const d = await propose(ctx, { agentId: own._id, contactId: payee._id, amount: r.amountMajor, reason: title }, { quiet: true, channel: turn.channel });
      if (d.outcome === "submitted") return say(turn, `Paying ${payee.name} ${label} within my limits. I'll show it as paid once it's confirmed.${replaced}`, { taskId: d.taskId, draft });
      // The first reason is the one that matters in a sentence; the card lists the payment itself.
      if (d.outcome === "needs_approval") return say(turn, `${d.reason.split(". ")[0]!.replace(/^Above Your assistant's/, "Above my")}, so this ${label} payment to ${payee.name} needs your passkey.${replaced}`, { taskId: d.taskId, draft });
      if (d.outcome === "duplicate") return say(turn, "That payment already exists.", { taskId: d.taskId });
      return say(turn, `I can't pay that: ${d.reason}.${replaced}`, { draft });
    }
  }
  if (!payee.trusted) {
    return say(turn, `${payee.name} is a new contact. Payments to them wait until ${new Date(payee.holdUntil ?? Date.now()).toLocaleString("en-IN", { hour: "numeric", minute: "2-digit", weekday: "short", timeZone: turn.tz })}.${replaced}`);
  }
  const taskId = await createPayment(ctx, user, payee, minor, currency, title, turn.channel);
  const how = cur === "USD" ? "Review and approve." : "Approve it and I'll open UPI for you.";
  return say(turn, `Ready to send ${label} to ${payee.name}. ${how}${replaced}`, { taskId, draft });
}

/** Contacts the text names, or the bill's biller ("pay rent", "pay the electricity bill"). */
async function payeesIn(turn: Turn, text: string) {
  const direct = matchContacts(text, turn.payees);
  if (direct.length) return { payees: direct, bill: null };
  const bills = (await turn.ctx.db.query("obligations").withIndex("by_user_due", (q) => q.eq("userId", turn.user._id)).take(100)).filter((o) => o.status === "active");
  const bill = matchBill(text, bills)[0] ?? null;
  const payee = bill?.payeeId ? turn.payees.find((p) => p._id === bill.payeeId) : undefined;
  return { payees: payee ? [payee] : [], bill };
}

async function onPay(turn: Turn, intent: Extract<Intent, { kind: "pay" }>) {
  const { ctx, user } = turn;
  if (/-\s*[$₹€£]?\s*\d|[$₹€£]\s*-\s*\d/.test(turn.text)) return say(turn, "Payment amounts must be positive. Tell me the amount and currency you intend to pay.");
  // A contact named after the correction wins: "pay alex chen $5, no I meant alex rivera".
  const after = intent.corrected ? matchContacts(intent.corrected.tail, turn.payees) : [];
  const found = after.length ? { payees: after, bill: null } : await payeesIn(turn, turn.text);
  const { bill } = found;
  if (bill && !intent.amount) {
    const payee = found.payees[0];
    if (!payee) return say(turn, `${bill.name} is ${money(bill.amountMinor, bill.currency)}, due ${whenWords(bill.nextDueAt, turn.now, turn.tz)}. Add the biller as a contact first and I can prepare it.`);
    const taskId = await createPayment(ctx, user, payee, bill.amountMinor, bill.currency, bill.name, turn.channel);
    return say(turn, `${bill.name} is ${money(bill.amountMinor, bill.currency)}, due ${whenWords(bill.nextDueAt, turn.now, turn.tz)}. Approve it and I'll open UPI for you.`, {
      taskId,
      draft: payee ? { payeeId: payee._id, amountMajor: bill.amountMinor / unitOf(bill.currency), cur: "LOCAL", direct: false } : undefined,
    });
  }
  // "...instead" or "actually, pay…" replaces the request chat made last, if it's still open.
  const replaces = intent.supersedes && turn.draft?.task && OPEN_STATES.has(turn.draft.task.state) ? turn.draft.task : null;
  return pay(turn, {
    payees: found.payees,
    payeeText: payeeWords(turn.text),
    amountMajor: intent.amount?.major,
    cur: intent.amount?.cur,
    reason: intent.reason,
    direct: intent.direct,
    replaces,
    instead: intent.corrected?.from?.major ?? null,
  });
}

/** "no wait, make it $6", "actually Alex Chen": change the open request instead of adding one. */
async function onCorrection(turn: Turn, intent: Extract<Intent, { kind: "correction" }>) {
  const named = intent.rest ? matchContacts(intent.rest, turn.payees) : [];
  if (turn.pending?.kind === "pay" && (await resume(turn, turn.pending, true))) return;
  const open = turn.draft;
  if (!open || (!intent.amount && !named.length)) {
    // Nothing to correct: read the rest as a fresh message ("actually, what can I spend?").
    if (intent.rest && intent.rest !== normalize(turn.text)) return answer({ ...turn, text: intent.rest }, classify(intent.rest), false);
    return say(turn, "There's no payment open to change. Tell me who to pay and how much, like \"pay Blue Tokai $4\".");
  }
  const task = open.task;
  if (task && !OPEN_STATES.has(task.state)) {
    const payee = task.payeeId ? turn.payees.find((p) => p._id === task.payeeId)?.name : undefined;
    return say(turn, `I can't change that one: ${describeTask(task, payee, turn.tz, turn.now).replace(/^The /, "the ")} If you want to pay again, tell me the new payment in full.`, { taskId: task._id });
  }
  const payees = named.length ? named : turn.payees.filter((p) => p._id === open.draft.payeeId);
  return pay(turn, {
    payees,
    payeeText: intent.rest,
    amountMajor: intent.amount?.major ?? open.draft.amountMajor,
    cur: intent.amount?.cur ?? open.draft.cur,
    reason: open.draft.reason,
    // Still the owner's own direct order only if the correction just restates the amount.
    direct: open.draft.direct && !named.length && isStrictTail(turn.text),
    replaces: task,
  });
}

/** An answer to the question the last reply asked. Returns false when the message isn't one. */
async function resume(turn: Turn, p: Extract<Pending, { kind: "pay" }>, correcting = false): Promise<boolean> {
  const t = turn.text;
  const candidates = turn.payees.filter((x) => p.payeeIds.includes(x._id));
  const amount = pickAmount(amounts(t));
  const shortAnswer = t.length <= 60 && !/[?\n"“”]/.test(t) && !/\b(not|don'?t|wait|maybe|but|later|stop|cancel)\b/i.test(t);
  // Only a clarification answer can resume an old order, never a new question or pasted prose.
  if (!shortAnswer) return false;
  let payees = candidates.length === 1 ? candidates : [];
  let amountMajor = p.amountMajor;
  let cur = p.cur ?? null;
  let answered = false;
  if (p.missing === "payee") {
    const i = ordinal(t);
    const named = matchContacts(t, candidates);
    const anyNamed = named.length ? named : matchContacts(t, turn.payees);
    if (i !== null && candidates[i]) payees = [candidates[i]!];
    else if (anyNamed.length) payees = anyNamed;
    answered = payees.length > 0;
    if (!answered) payees = candidates;
  }
  if (amount) {
    amountMajor = amount.major;
    if (amount.cur) cur = amount.cur;
    answered = true;
  }
  if (p.missing === "currency" || (!cur && answered)) {
    const c = currencyWord(t);
    if (c) {
      cur = c;
      answered = true;
    }
  }
  if (!answered) return false;
  const replaces = p.replaces ? await turn.ctx.db.get(p.replaces) : null;
  await pay(turn, {
    payees,
    payeeText: p.missing === "payee" ? t : null,
    amountMajor,
    cur,
    reason: p.reason,
    // The original order was direct; a plain answer to "which one?" keeps it the owner's own order.
    direct: p.direct && shortAnswer && (!correcting || isStrictTail(t)),
    replaces,
  });
  return true;
}

async function overviewOf(turn: Turn) {
  return await computeOverview(turn.ctx, turn.user);
}

async function onSafe(turn: Turn, amount: Extract<Intent, { kind: "safe" }>["amount"]) {
  const o = await overviewOf(turn);
  const avail = money(o.available, o.currency);
  if (!amount) {
    return say(turn, `You have ${avail} after rent, bills and your emergency fund. That's about ${money(o.perDay, o.currency)} a day for the next ${o.daysToIncome} days.`);
  }
  let minor = toMinor(amount.major, amount.cur === "USD" ? "USD" : o.currency);
  if (amount.cur === "USD" && o.currency !== "USD") {
    try {
      minor = convert(minor, "USD", o.currency, (await latestRates(turn.ctx)).fiat);
    } catch {
      return say(turn, `I don't have today's dollar rate, so I can't compare. You have ${avail} safe to spend.`);
    }
  }
  const asked = money(minor, o.currency);
  if (minor <= o.available) {
    return say(turn, `Yes, ${asked} fits. You'd still have ${money(o.available - minor, o.currency)} safe to spend over the next ${o.daysToIncome} days, after bills and your emergency fund.`);
  }
  return say(turn, `Not comfortably: ${asked} is more than the ${avail} you have safe to spend after bills and your emergency fund, so it would dip into money set aside.`);
}

async function onBills(turn: Turn, subscriptions: boolean) {
  const { ctx, user, now, tz } = turn;
  const t = normalize(turn.text);
  const rows = (await ctx.db.query("obligations").withIndex("by_user_due", (q) => q.eq("userId", user._id).gte("nextDueAt", now - 7 * DAY)).take(100)).filter((o) => o.status === "active");
  const named = matchBill(t, rows);
  if (subscriptions) {
    const subs = rows.filter((b) => b.kind === "subscription");
    if (/\b(stop|cancel|end|unsubscribe|pause)\b/.test(t)) {
      const sub = named[0] ?? null;
      if (sub) return say(turn, `I can't cancel ${sub.name} for you; cancel it with ${sub.name} directly, then mark it cancelled in Money → Bills. It's ${money(sub.amountMinor, sub.currency)} ${sub.cadence === "yearly" ? "a year" : sub.cadence === "weekly" ? "a week" : "a month"}, next renewing ${whenWords(sub.nextDueAt, now, tz)}. I haven't changed anything.`);
      return say(turn, "I can't cancel subscriptions from chat. Cancel it with the provider, then mark it cancelled in Money → Bills. Nothing has been changed.");
    }
    if (!subs.length) return say(turn, "I don't see any active subscriptions.");
    const sameCurrency = subs.every((b) => b.currency === subs[0]!.currency);
    const monthly = subs.reduce((s, b) => s + (b.cadence === "yearly" ? Math.round(b.amountMinor / 12) : b.cadence === "weekly" ? Math.round((b.amountMinor * 52) / 12) : b.amountMinor), 0);
    const changed = subs.filter((b) => b.previousAmountMinor && b.previousAmountMinor !== b.amountMinor);
    const next = [...subs].sort((a, b) => a.nextDueAt - b.nextDueAt)[0]!;
    const parts = [
      `${subs.length} subscriptions${sameCurrency ? `, about ${money(monthly, subs[0]!.currency)} a month` : " in different currencies"}: ${subs.map((s) => `${s.name} ${money(s.amountMinor, s.currency)}${s.cadence === "yearly" ? "/yr" : ""}`).join(", ")}.`,
      `Next renewal: ${next.name} ${whenWords(next.nextDueAt, now, tz)}.`,
    ];
    if (changed.length) parts.push(`Price changes: ${changed.map((c) => `${c.name} ${money(c.previousAmountMinor!, c.currency)} → ${money(c.amountMinor, c.currency)}`).join(", ")}.`);
    return say(turn, parts.join(" "));
  }
  if (named.length && /\bwhen\b|\bdue\b|\bhow much\b/.test(t)) {
    return say(turn, named.map((b) => `${b.name} is ${money(b.amountMinor, b.currency)}, due ${whenWords(b.nextDueAt, now, tz)} (${dateLabel(b.nextDueAt, tz)}).`).join("\n"));
  }
  const n = local(now, tz);
  const [until, label] = /\btoday\b/.test(t)
    ? [zoned(n.year, n.month, n.day + 1, 0, 0, tz), "today"]
    : /\btomorrow\b/.test(t)
      ? [zoned(n.year, n.month, n.day + 2, 0, 0, tz), "by tomorrow"]
      : /\bthis week\b|\bnext 7 days\b|\bweek\b/.test(t)
        ? [now + 7 * DAY, "in the next 7 days"]
        : /\bthis month\b/.test(t)
          ? [zoned(n.year, n.month + 1, 1, 0, 0, tz), "this month"]
          : [now + 30 * DAY, "in the next 30 days"];
  const due = rows.filter((b) => (b.kind === "bill" || /\b(payments|everything|all)\b/.test(t)) && b.nextDueAt < until).sort((a, b) => a.nextDueAt - b.nextDueAt);
  if (!due.length) {
    const next = rows.filter((b) => b.kind === "bill").sort((a, b) => a.nextDueAt - b.nextDueAt)[0];
    return say(turn, next ? `No bills due ${label}. Next: ${next.name} ${money(next.amountMinor, next.currency)}, ${whenWords(next.nextDueAt, now, tz)}.` : "I don't see any bills yet. Import a statement or add one in Money → Bills.");
  }
  const total = due.every((b) => b.currency === due[0]!.currency) ? ` Total ${money(due.reduce((s, b) => s + b.amountMinor, 0), due[0]!.currency)}.` : "";
  const lines = due.slice(0, 8).map((b) => `${b.name} ${money(b.amountMinor, b.currency)}, ${b.nextDueAt < now ? "overdue" : `due ${whenWords(b.nextDueAt, now, tz)}`}`);
  return say(turn, `Due ${label}:\n${lines.join("\n")}${due.length > 1 ? `\n${total.trim()}` : ""}`);
}

async function onRemind(turn: Turn, pendingText?: string, pendingBill?: Id<"obligations">, pendingRepeat?: "monthly" | "weekly") {
  const { ctx, user, now, tz } = turn;
  const what = pendingText ?? reminderWhat(turn.text);
  if (!what) return say(turn, "What should I remind you about, and when? For example: \"remind me to pay rent on the 1st\".");
  const bills = (await ctx.db.query("obligations").withIndex("by_user_due", (q) => q.eq("userId", user._id)).take(100)).filter((o) => o.status === "active");
  const bill = pendingBill ? (bills.find((b) => b._id === pendingBill) ?? null) : (matchBill(what, bills)[0] ?? null);
  const repeat = pendingRepeat ?? parseRepeat(normalize(turn.text));
  let when = parseWhen(turn.text, now, tz);
  if (!when && bill) {
    const lead = user.reminderLeadDays ?? 2;
    const d = local(bill.nextDueAt, tz);
    when = Math.max(now + 5 * MINUTE, zoned(d.year, d.month, d.day - lead, 9, 0, tz));
  }
  if (!when) {
    return say(turn, `When should I remind you to ${what.charAt(0).toLowerCase()}${what.slice(1)}? For example "tomorrow at 9am" or "on the 1st".`, {
      suggestions: ["Tomorrow at 9am", "On the 1st", "In 3 days"],
      pending: { kind: "remind", text: what, obligationId: bill?._id, repeat },
    });
  }
  await createReminder(ctx, user, { text: what, dueAt: when, repeat, obligationId: bill?._id });
  const where = wantsTelegram(user) && (await telegramLinked(ctx, user._id)) ? "here and on Telegram" : "here in the app";
  const quiet = inQuietHours(when, tz, user.quietFrom ?? "22:00", user.quietTo ?? "08:00") ? " That's in your quiet hours, so it'll arrive when they end." : "";
  const billNote = bill ? ` ${bill.name} is ${money(bill.amountMinor, bill.currency)}, due ${whenWords(bill.nextDueAt, now, tz)}.` : "";
  const every = repeat ? ` and then every ${repeat === "monthly" ? "month" : "week"}` : "";
  return say(turn, `Done. I'll remind you to ${what.charAt(0).toLowerCase()}${what.slice(1)} on ${dateLabel(when, tz, true)}${every}, ${where}.${quiet}${billNote}`);
}

async function onReminders(turn: Turn, cancel: boolean) {
  const { ctx, user, tz } = turn;
  const rows = await ctx.db.query("reminders").withIndex("by_user", (q) => q.eq("userId", user._id).eq("status", "scheduled")).take(50);
  const lead = user.reminderLeadDays ?? 2;
  const auto = `Bills and renewals are reminded ${lead === 0 ? "on the day" : `${lead} ${lead === 1 ? "day" : "days"} before`}, outside your quiet hours (${user.quietFrom ?? "22:00"}–${user.quietTo ?? "08:00"}).`;
  if (cancel) {
    const t = normalize(turn.text);
    const hits = /\ball\b|\bevery\b/.test(t) ? rows : matchContacts(t, rows.map((r) => ({ ...r, name: r.text })));
    const chosen = hits.length ? hits : rows.length === 1 ? rows : [];
    if (!chosen.length) {
      return say(turn, rows.length ? `Which one? ${rows.map((r) => r.text).join(", ")}.` : "You have no reminders waiting.", { suggestions: rows.slice(0, 4).map((r) => `Cancel the ${r.text.toLowerCase()} reminder`) });
    }
    for (const r of chosen) await ctx.db.patch(r._id, { status: "cancelled" });
    return say(turn, `Cancelled ${chosen.length === 1 ? `the "${chosen[0]!.text}" reminder` : `${chosen.length} reminders`}.`);
  }
  if (!rows.length) return say(turn, `You haven't asked me for any reminders. ${auto}`, { suggestions: ["Remind me to pay rent on the 1st"] });
  const lines = rows.sort((a, b) => a.dueAt - b.dueAt).map((r) => `${r.text}: ${dateLabel(r.dueAt, tz, true)}${r.repeat ? ` (every ${r.repeat === "monthly" ? "month" : "week"})` : ""}`);
  return say(turn, `Your reminders:\n${lines.join("\n")}\n${auto}`);
}

async function onGoal(turn: Turn, intent: Extract<Intent, { kind: "goal_set" }>) {
  const { ctx, user, now, tz } = turn;
  const currency: Currency = intent.amount.cur === "USD" ? "USD" : user.currency;
  const targetMinor = toMinor(intent.amount.major, currency);
  const dueAt = parseDeadline(turn.text, now, tz) ?? undefined;
  const { match } = await findGoal(ctx, user._id, intent.name);
  const name = match?.name ?? titleCase(intent.name ?? "Savings");
  const saved = match && match.currency === currency ? match.savedMinor : 0;
  const plan = goalPlan({ targetMinor, savedMinor: saved, currency, dueAt }, now);
  const m = (n: number) => money(n, currency);
  const parts: string[] = [];
  parts.push(`${name}: ${m(targetMinor)}${dueAt ? ` by ${dateLabel(dueAt, tz)}` : ""}.`);
  if (saved) parts.push(`You've saved ${m(saved)} toward it, so ${m(plan.remaining)} to go.`);
  if (plan.monthly !== null) parts.push(`That's ${m(plan.monthly)} a month for ${plan.months} ${plan.months === 1 ? "month" : "months"}.`);
  const o = await overviewOf(turn);
  if (o.currency === currency && plan.monthly !== null) {
    parts.push(
      plan.monthly <= o.available
        ? `You have ${money(o.available, o.currency)} safe to spend over the next ${o.daysToIncome} days, so this month's share fits.`
        : `That's more than the ${money(o.available, o.currency)} you have safe to spend over the next ${o.daysToIncome} days, so it's a stretch right now.`,
    );
  }
  if (intent.question) {
    parts.push(match ? `Want me to set ${match.name} to ${m(targetMinor)}${dueAt ? ` by ${dateLabel(dueAt, tz)}` : ""}?` : "Want me to save this as a goal?");
    return say(turn, parts.join(" "), { suggestions: ["Yes", "Not now"], pending: { kind: "goal", goalId: match?._id, name, targetMinor, currency, dueAt } });
  }
  const { created } = await saveGoal(ctx, user, { goalId: match?._id, name, targetMinor, currency, dueAt });
  parts[0] = `${created ? "New goal" : "Updated goal"}: ${parts[0]}`;
  return say(turn, parts.join(" "));
}

async function onGoalProgress(turn: Turn) {
  const { goals, match } = await findGoal(turn.ctx, turn.user._id, turn.text);
  if (!goals.length) return say(turn, "You don't have any savings goals yet. Try \"save ₹50,000 for a laptop by March\".", { suggestions: ["Save $500 for a trip by December"] });
  const chosen = match ? [match] : goals.slice(0, 6);
  return say(turn, chosen.map((g) => goalLine(g, turn.tz, turn.now)).join("\n"));
}

async function onSpending(turn: Turn) {
  const s = await spendingSummary(turn.ctx, turn.user, turn.text, turn.now);
  return say(turn, spendingSentence(s));
}

async function onStatus(turn: Turn) {
  const { ctx, user } = turn;
  const named = matchContacts(turn.text, turn.payees);
  let task: Doc<"tasks"> | null = null;
  if (named.length === 1) {
    const rows = await ctx.db.query("tasks").withIndex("by_payee", (q) => q.eq("payeeId", named[0]!._id)).order("desc").take(20);
    task = rows.find((x) => x.userId === user._id && x.amountMinor !== undefined) ?? null;
  }
  if (!task && turn.draft?.task) task = turn.draft.task;
  if (!task) {
    const recent = await ctx.db.query("tasks").withIndex("by_user_updated", (q) => q.eq("userId", user._id)).order("desc").take(20);
    task = recent.find((x) => x.amountMinor !== undefined && x.payeeId) ?? null;
  }
  if (!task) return say(turn, named.length === 1 ? `I don't see any payments to ${named[0]!.name}.` : "I don't see any payments yet.");
  const payee = task.payeeId ? (await ctx.db.get(task.payeeId))?.name : undefined;
  return say(turn, describeTask(task, payee, turn.tz, turn.now), { taskId: task._id });
}

/** The newest request chat made that can still be cancelled. */
async function openRequest(turn: Turn) {
  if (turn.draft?.task && OPEN_STATES.has(turn.draft.task.state)) return turn.draft.task;
  const rows = await turn.ctx.db.query("tasks").withIndex("by_user_state", (q) => q.eq("userId", turn.user._id).eq("state", "awaiting_approval")).order("desc").take(20);
  return rows.find((x) => (x.channel === "app" || x.channel === "telegram") && x.amountMinor !== undefined && x.payeeId) ?? null;
}

async function onCancel(turn: Turn, payeeId?: Id<"payees">) {
  if (turn.pending && !payeeId) return say(turn, "OK, dropped it. Nothing was paid or saved.");
  const task = await openRequest(turn);
  if (!task || (payeeId && task.payeeId !== payeeId)) return say(turn, "There's nothing waiting to cancel.");
  const payee = task.payeeId ? turn.payees.find((p) => p._id === task.payeeId)?.name : undefined;
  await closeTask(turn.ctx, task, "Cancelled in chat");
  return say(turn, `Cancelled the ${money(task.amountMinor ?? 0, task.currency ?? "USDC")} payment${payee ? ` to ${payee}` : ""}. Nothing was paid.`, { taskId: task._id });
}

async function onFreeze(turn: Turn) {
  const { ctx, user, channel } = turn;
  const agents = await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50);
  const named = matchContacts(turn.text, agents.filter((a) => a.provider !== "own" && a.status !== "revoked"));
  if (named.length === 1 && !/\b(all|every|everything|agents)\b/.test(normalize(turn.text))) {
    const a = named[0]!;
    if (a.status === "frozen") return say(turn, `${a.name} is already frozen.`);
    await freezeAgent(ctx, user, a);
    await ctx.db.insert("activity", { userId: user._id, kind: "agent", title: `${a.name} frozen`, detail: channel === "telegram" ? "From Telegram" : "From chat", tone: "warn" });
    return say(turn, `Froze ${a.name}. It can't spend through us now${a.chainAddress ? "; the vault confirms the freeze in a few seconds (see Activity)" : ""}. Unfreezing needs you in the app.`);
  }
  // Same path as the dashboard: our gateway stops now, and each agent's key is frozen in the vault.
  const n = await freezeAll(ctx, user, channel === "telegram" ? "From Telegram" : "From chat");
  return say(
    turn,
    n ? `Froze ${n} ${n === 1 ? "agent" : "agents"}. They can't spend through us now; the vault confirms each freeze in a few seconds (see Activity).` : "All agents are already frozen.",
  );
}

/**
 * Unfreezing loosens control, so chat never does it by itself: on a live vault it prepares the
 * passkey approval (the vault then waits out its delay); otherwise it points to the app.
 */
async function onUnfreeze(turn: Turn) {
  const { ctx, user } = turn;
  const agents = (await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50)).filter((a) => a.status === "frozen");
  if (!agents.length) return say(turn, "No agents are frozen.");
  const named = matchContacts(turn.text, agents);
  const chosen = named.length ? named : agents.length === 1 ? agents : [];
  if (!chosen.length) return say(turn, `Which agent: ${agents.map((a) => a.name).join(", ")}?`, { suggestions: agents.slice(0, 4).map((a) => `Unfreeze ${a.name}`) });
  const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
  const live = wallet?.status === "live" && isVaultVersion(wallet.version);
  const a = chosen[0]!;
  if (live && a.chainAddress) {
    const taskId = await unfreezeTask(ctx, user, a);
    return say(turn, `Unfreezing ${a.name} loosens control, so it needs your passkey, and then the vault waits out its delay before ${a.name} can spend again.`, { taskId });
  }
  return say(turn, `Unfreezing loosens control, so I don't do it from chat. Open Agents → ${a.name} → Unfreeze in the app.`);
}

async function onHedge(turn: Turn) {
  if (turn.pending) return say(turn, "No problem, take your time. Nothing has been paid or saved.", { pending: turn.pending });
  const task = turn.draft?.task;
  if (task && OPEN_STATES.has(task.state)) {
    const payee = task.payeeId ? turn.payees.find((p) => p._id === task.payeeId)?.name : undefined;
    return say(turn, `Nothing has been paid. The ${money(task.amountMinor ?? 0, task.currency ?? "USDC")} payment${payee ? ` to ${payee}` : ""} is waiting for your approval and won't go anywhere until you approve it. Say "cancel it" to drop it.`);
  }
  return say(turn, "Take your time. I haven't done anything.");
}

async function onYes(turn: Turn) {
  const p = turn.pending;
  if (p?.kind === "goal") {
    const { created } = await saveGoal(turn.ctx, turn.user, { goalId: p.goalId, name: p.name, targetMinor: p.targetMinor, currency: p.currency, dueAt: p.dueAt });
    return say(turn, `${created ? "Saved a new goal" : "Updated"}: ${p.name}, ${money(p.targetMinor, p.currency)}${p.dueAt ? ` by ${dateLabel(p.dueAt, turn.tz)}` : ""}. You'll find it in Money → Goals.`);
  }
  if (p?.kind === "pay") {
    const names = turn.payees.filter((x) => p.payeeIds.includes(x._id)).map((x) => x.name);
    const q = p.missing === "payee" ? `Which one: ${names.join(", ")}?` : p.missing === "amount" ? "How much?" : "Dollars from the agent wallet, or your own money by UPI?";
    return say(turn, `I need one more thing first. ${q}`, { pending: p, suggestions: p.missing === "payee" ? names.slice(0, 4) : undefined });
  }
  if (p?.kind === "remind") return say(turn, `When should I remind you to ${p.text.toLowerCase()}?`, { pending: p });
  const task = turn.draft?.task;
  if (task && OPEN_STATES.has(task.state)) {
    return say(turn, `I can't approve payments from chat. Approve the ${money(task.amountMinor ?? 0, task.currency ?? "USDC")} payment on its card${task.action ? " with your passkey" : ""}.`, { taskId: task._id });
  }
  return say(turn, `Yes to what? ${HELP}`, { suggestions: HELP_CHIPS });
}

async function onNo(turn: Turn) {
  if (turn.pending) return say(turn, "OK, dropped it. Nothing was paid or saved.");
  const task = turn.draft?.task;
  if (task && OPEN_STATES.has(task.state)) {
    const payee = task.payeeId ? turn.payees.find((p) => p._id === task.payeeId)?.name : undefined;
    return say(turn, `OK. The ${money(task.amountMinor ?? 0, task.currency ?? "USDC")} payment${payee ? ` to ${payee}` : ""} is still waiting for approval; say "cancel it" to drop it, or leave it to expire.`);
  }
  return say(turn, "OK.");
}

async function answer(turn: Turn, intent: Intent, allowResume = true): Promise<void> {
  // A reply to the question just asked ("which Alex?", "dollars or rupees?", "when?") comes first.
  const p = turn.pending;
  const answers = ["unknown", "correction"].includes(intent.kind);
  if (allowResume && p?.kind === "pay" && answers && (await resume(turn, p))) return;
  if (allowResume && p?.kind === "remind" && answers) {
    if (parseWhen(turn.text, turn.now, turn.tz)) return onRemind(turn, p.text, p.obligationId, p.repeat ?? parseRepeat(normalize(turn.text)));
  }
  switch (intent.kind) {
    case "help":
      return say(turn, HELP, { suggestions: HELP_CHIPS });
    case "greeting":
      return say(turn, `Hi${turn.user.name ? ` ${turn.user.name}` : ""}. ${HELP}`, { suggestions: HELP_CHIPS });
    case "yes":
      return onYes(turn);
    case "no":
      return onNo(turn);
    case "hedge":
      return onHedge(turn);
    case "freeze":
      return onFreeze(turn);
    case "unfreeze":
      return onUnfreeze(turn);
    case "status":
      return onStatus(turn);
    case "cancel":
      return onCancel(turn);
    case "dont_pay": {
      const who = matchContacts(turn.text, turn.payees);
      const task = await openRequest(turn);
      if (who.length === 1 && task?.payeeId === who[0]!._id) return onCancel(turn, who[0]!._id);
      return say(turn, `OK, I won't pay ${who.length === 1 ? who[0]!.name : "anyone"}. Nothing was sent.`);
    }
    case "dont_freeze":
      return say(turn, "OK, I won't freeze anything. Your agents are as they were.");
    case "scam": {
      const who = matchContacts(turn.text, turn.payees);
      return say(
        turn,
        `That looks like a scam: pressure to pay right away, or a threat to cut you off, is the usual trick. I haven't paid ${who.length === 1 ? who[0]!.name : "anyone"}. Check with them through their own app or number, not a link or number in the message.`,
      );
    }
    case "quoted":
      return say(turn, `I don't pay from quoted or pasted text, so nothing was sent. If you want to pay, type it yourself, like "pay Blue Tokai $5".`);
    case "pay_question": {
      const o = await overviewOf(turn);
      return say(
        turn,
        `That's your call, so I haven't paid anything. You have ${money(o.available, o.currency)} safe to spend after rent, bills and your emergency fund. If you want to go ahead, tell me to pay, with the amount.`,
      );
    }
    case "correction":
      return onCorrection(turn, intent);
    case "pay":
      return onPay(turn, intent);
    case "spending":
      return onSpending(turn);
    case "bills":
      return onBills(turn, false);
    case "subscriptions":
      return onBills(turn, true);
    case "safe":
      return onSafe(turn, intent.amount);
    case "remind":
      return onRemind(turn);
    case "reminders":
      return onReminders(turn, false);
    case "reminder_cancel":
      return onReminders(turn, true);
    case "goal_set":
      return onGoal(turn, intent);
    case "goal_progress":
      return onGoalProgress(turn);
    default:
      return say(turn, `I didn't catch that. ${HELP}`, { suggestions: HELP_CHIPS });
  }
}

/**
 * The basic assistant: rule-based replies, used when there is no model key, the day's model quota
 * is spent, or the model call fails. Deterministic; every figure comes from the owner's data or
 * their own words, and payments go through the same gateway as any agent's.
 */
export const reply = internalMutation({
  args: {
    userId: v.id("users"),
    text: v.string(),
    channel: v.optional(v.union(v.literal("app"), v.literal("telegram"))),
    /** Why the model didn't answer (missing_key, quota, no_own_agent, api_error:<status>); stored on the reply. */
    fallback: v.optional(v.string()),
  },
  handler: async (ctx, { userId, text, channel = "app", fallback }) => {
    const user = await ctx.db.get(userId);
    if (!user) return;
    const now = Date.now();
    const payees = await ctx.db.query("payees").withIndex("by_user", (q) => q.eq("userId", userId)).take(200);
    // The conversation so far: an open question from the last reply, and the last payment chat proposed.
    const recent = await ctx.db.query("messages").withIndex("by_user", (q) => q.eq("userId", userId)).order("desc").take(12);
    const fresh = recent.filter((m) => m.role === "assistant" && now - m._creationTime < OPEN_FOR);
    const lastReply = recent.find((m) => m.role === "assistant");
    const pending = lastReply?.pending && now - lastReply._creationTime < OPEN_FOR ? lastReply.pending : null;
    const withDraft = fresh.find((m) => m.draft);
    const draftTask = withDraft?.taskId ? await ctx.db.get(withDraft.taskId) : null;
    const turn: Turn = {
      ctx,
      user,
      text: text.trim().slice(0, 500),
      channel,
      tz: safeTz(user.timezone),
      now,
      mode: "basic",
      fallback,
      payees,
      pending,
      draft: withDraft?.draft ? { draft: withDraft.draft, task: draftTask } : null,
    };
    await answer(turn, classify(turn.text));
  },
});
