import { v } from "convex/values";
import { freezeAll } from "./lib/control";
import { propose } from "./gateway";
import { formatMoney } from "@agent-wallet/domain";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireViewer, viewer } from "./lib/auth";
import { computeOverview } from "./lib/overview";
import { newApprovalToken } from "./lib/seed";
import { ownerPayTask } from "./lib/actions";
import { withNames } from "./tasks";
import { spendAssistantTurn } from "./lib/budget";

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

const DAY = 86_400_000;

function dueIn(at: number) {
  const days = Math.round((at - Date.now()) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

async function createPayment(
  ctx: MutationCtx,
  user: Doc<"users">,
  payee: Doc<"payees">,
  amountMinor: number,
  currency: "INR" | "USDC",
  title: string,
) {
  if (currency === "USDC") {
    const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    if (wallet?.status === "live") {
      const { taskId } = await ownerPayTask(ctx, { user, payee, amountMinor, title, channel: "app", reason: "You're paying from your agent wallet" });
      return taskId;
    }
  }
  const taskId = await ctx.db.insert("tasks", {
    userId: user._id,
    title,
    channel: "app",
    payeeId: payee._id,
    amountMinor,
    currency,
    state: "awaiting_approval",
    reason: currency === "INR" ? "Bank payments need your approval" : "New request from chat",
    rail: currency === "INR" ? "handoff" : "simulator",
    approvalToken: newApprovalToken(),
    expiresAt: Date.now() + 30 * 60_000,
    updatedAt: Date.now(),
  });
  return taskId;
}

/**
 * Rule-based replies until the model-backed assistant is connected. Every number
 * comes from the same overview the dashboard shows.
 */
export const reply = internalMutation({
  args: { userId: v.id("users"), text: v.string(), channel: v.optional(v.union(v.literal("app"), v.literal("telegram"))) },
  handler: async (ctx, { userId, text, channel = "app" }) => {
    const user = await ctx.db.get(userId);
    if (!user) return;
    const t = text.toLowerCase();
    const say = async (reply: string, taskId?: Id<"tasks">) => {
      await ctx.db.insert("messages", { userId, role: "assistant", text: reply, channel, taskId });
      if (channel === "telegram") {
        const task = taskId ? await ctx.db.get(taskId) : null;
        const base = process.env.APPROVE_URL ?? "https://agent-wallet-approve.vercel.app";
        await ctx.scheduler.runAfter(0, internal.telegram.send, {
          userId,
          text: reply,
          approvalUrl: task?.approvalToken ? `${base}/a/${task.approvalToken}` : undefined,
        });
      }
    };

    if (/\b(freeze|stop|lock|panic)\b/.test(t)) {
      // Same path as the dashboard: our gateway stops now, and each agent's key is frozen in the vault.
      const user = (await ctx.db.get(userId))!;
      const n = await freezeAll(ctx, user, channel === "telegram" ? "From Telegram" : "From chat");
      return say(
        n
          ? `Froze ${n} ${n === 1 ? "agent" : "agents"}. They can't spend through us now; the vault confirms each freeze in a few seconds (see Activity).`
          : "All agents are already frozen.",
      );
    }

    const payees = await ctx.db.query("payees").withIndex("by_user", (q) => q.eq("userId", userId)).take(200);
    const bills = (
      await ctx.db
        .query("obligations")
        .withIndex("by_user_due", (q) => q.eq("userId", userId).gte("nextDueAt", Date.now() - DAY))
        .take(100)
    ).filter((o) => o.status === "active");

    if (/\b(pay|send|transfer)\b/.test(t)) {
      // A dollar sign names the amount; otherwise the first number does.
      const amount = t.match(/\$\s*(\d[\d,]*(?:\.\d{1,2})?)/) ?? t.match(/(?:₹|rs\.?|inr|\$|usd)?\s*(\d[\d,]*(?:\.\d{1,2})?)/);
      // Only a short, direct order pays on its own. A question, a negation, quoted or pasted text, or
      // more than one number gets an approval card instead: this parser can't tell a request from a quote.
      const direct =
        text.length <= 80 &&
        /^(please\s+)?(pay|send|transfer)\b/.test(t.trim()) &&
        !/[\n?"“”‘’`]|'\s|\s'|^'|'$/.test(text.trim()) &&
        !/\b(don'?t|do not|not|never|no|stop|cancel|wait|should|whether|if|maybe|later)\b/.test(t) &&
        (t.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).length === 1;
      const isDollar = /\$|usd|dollar/.test(t);
      const aliases: Record<string, string> = { electricity: "bescom", power: "bescom", phone: "airtel", landlord: "rent" };
      const words = Object.entries(aliases).reduce((s, [k, v2]) => (s.includes(k) ? `${s} ${v2}` : s), t);
      const bill = bills.find((b) => words.includes(b.name.toLowerCase().split(" ")[0]!));
      if (bill && !amount) {
        const payee = bill.payeeId ? await ctx.db.get(bill.payeeId) : null;
        if (!payee) return say(`${bill.name} is ${formatMoney(bill.amountMinor, bill.currency)}, due ${dueIn(bill.nextDueAt)}. Add the biller as a contact first and I can prepare it.`);
        const taskId = await createPayment(ctx, user, payee, bill.amountMinor, "INR", bill.name);
        return say(`${bill.name} is ${formatMoney(bill.amountMinor, bill.currency)}, due ${dueIn(bill.nextDueAt)}. Approve it and I'll open UPI for you.`, taskId);
      }
      const payee = payees.find((p) => {
        const first = p.name.toLowerCase().split(" ")[0]!;
        return t.includes(first);
      });
      if (!payee) return say("I can only pay people and billers in your contacts. Who should it go to?");
      if (!amount) return say(`How much should I send ${payee.name}?`);
      const major = Number(amount[1]!.replace(/,/g, ""));
      const currency = isDollar ? "USDC" : "INR";
      const minor = Math.round(major * 100);
      // Dollars come from the agent wallet: the assistant gets the same decision any agent gets,
      // so inside its limits it pays, above them it asks you, and the vault has the last word.
      const own = isDollar && direct ? await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", userId)).take(50).then((a) => a.find((x) => x.provider === "own" && x.status === "active")) : undefined;
      if (own) {
        const d = await propose(ctx, { agentId: own._id, contactId: payee._id, amount: major, reason: `Pay ${payee.name}` }, { quiet: true, channel });
        if (d.outcome === "submitted") return say(`Paying ${payee.name} ${formatMoney(minor, "USDC")} within my limits. I'll show it as paid once it's confirmed.`, d.taskId);
        // The first reason is the one that matters in a sentence; the card lists the payment itself.
        if (d.outcome === "needs_approval") return say(`${d.reason.split(". ")[0]!.replace(/^Above Your assistant's/, "Above my")}, so this one needs your passkey.`, d.taskId);
        if (d.outcome === "duplicate") return say("That payment already exists.", d.taskId);
        return say(`I can't pay that: ${d.reason}.`);
      }
      if (!payee.trusted) return say(`${payee.name} is a new contact. Payments to them wait until ${new Date(payee.holdUntil ?? Date.now()).toLocaleString("en-IN", { hour: "numeric", minute: "2-digit", weekday: "short" })}.`);
      const taskId = await createPayment(ctx, user, payee, minor, currency, `Pay ${payee.name}`);
      return say(`Ready to send ${formatMoney(minor, currency)} to ${payee.name}. Review and approve.`, taskId);
    }

    const overview = await computeOverview(ctx, user);

    if (/\b(afford|spend|left|available|budget|money)\b/.test(t)) {
      return say(
        `You have ${formatMoney(overview.available, overview.currency)} after rent, bills and your emergency fund. That's about ${formatMoney(overview.perDay, overview.currency)} a day for the next ${overview.daysToIncome} days.`,
      );
    }
    if (/\b(bill|bills|due|rent)\b/.test(t)) {
      const next = bills.filter((b) => b.kind === "bill").slice(0, 3);
      return say(next.map((b) => `${b.name} ${formatMoney(b.amountMinor, b.currency)}, ${dueIn(b.nextDueAt)}`).join("\n"));
    }
    if (/subscri/.test(t)) {
      const subs = bills.filter((b) => b.kind === "subscription");
      const monthly = subs.reduce((s, b) => s + (b.cadence === "yearly" ? Math.round(b.amountMinor / 12) : b.amountMinor), 0);
      return say(`${subs.length} subscriptions, about ${formatMoney(monthly, user.currency)} a month. ${subs.map((s) => s.name).join(", ")}.`);
    }
    return say("I can tell you what you can spend, list bills and subscriptions, pay a contact, or freeze your agents.");
  },
});
