import { v, ConvexError } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { own, requireViewer, viewer } from "./lib/auth";
import { formatMoney } from "@agent-wallet/domain";
import { afterTask } from "./lib/circle";

export async function withNames(ctx: QueryCtx, task: Doc<"tasks">) {
  const payee = task.payeeId ? await ctx.db.get(task.payeeId) : null;
  const agent = task.agentId ? await ctx.db.get(task.agentId) : null;
  return { ...task, payee: payee?.name, agent: agent?.name };
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return [];
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_user_updated", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(50);
    return await Promise.all(tasks.map((t) => withNames(ctx, t)));
  },
});

export const cancel = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const user = await requireViewer(ctx);
    const task = await own(user, await ctx.db.get(taskId));
    if (!["drafted", "needs_info", "checked", "awaiting_approval"].includes(task.state)) {
      throw new ConvexError("This payment has already been sent");
    }
    await ctx.db.patch(taskId, { state: "cancelled", approvalToken: undefined, updatedAt: Date.now() });
    await afterTask(ctx, (await ctx.db.get(taskId))!);
  },
});

/** Approvals nobody answered in time stop asking for attention. The vault would refuse them anyway. */
export const expireStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const stale = await ctx.db
      .query("tasks")
      .withIndex("by_state_expires", (q) => q.eq("state", "awaiting_approval").gt("expiresAt", 0).lt("expiresAt", Date.now()))
      .take(200);
    for (const t of stale) {
      await ctx.db.patch(t._id, { state: "expired", updatedAt: Date.now() });
      await afterTask(ctx, { ...t, state: "expired" });
    }
    return stale.length;
  },
});

/** Simulated rail: settles a submitted payment and records its effect. */
export const settle = internalMutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task || task.state !== "submitted") return;
    // A UPI handoff happened in the owner's bank app. Only their word says it was paid.
    const handoff = task.rail === "handoff";
    await ctx.db.patch(taskId, {
      state: handoff ? "reported" : "confirmed",
      reason: handoff ? "You marked this paid. Your bank hasn't confirmed it; it will match when your statement arrives." : task.reason,
      updatedAt: Date.now(),
    });
    const payee = task.payeeId ? await ctx.db.get(task.payeeId) : null;
    if (task.currency === "USDC" && task.amountMinor) {
      const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", task.userId)).unique();
      if (wallet) await ctx.db.patch(wallet._id, { balanceMinor: wallet.balanceMinor - task.amountMinor });
    }
    await afterTask(ctx, (await ctx.db.get(taskId))!);
    if (task.payeeId && task.currency && task.currency !== "USDC") {
      const bill = (
        await ctx.db
          .query("obligations")
          .withIndex("by_user_due", (q) => q.eq("userId", task.userId))
          .take(100)
      ).find((o) => o.payeeId === task.payeeId && o.status === "active");
      if (bill) {
        const next = new Date(bill.nextDueAt);
        if (bill.cadence === "monthly") next.setMonth(next.getMonth() + 1);
        else if (bill.cadence === "yearly") next.setFullYear(next.getFullYear() + 1);
        else next.setDate(next.getDate() + 7);
        await ctx.db.patch(bill._id, { nextDueAt: next.getTime() });
      }
      const bank = (
        await ctx.db
          .query("accounts")
          .withIndex("by_user", (q) => q.eq("userId", task.userId))
          .take(50)
      ).find((a) => a.kind === "bank" && a.currency === task.currency);
      if (bank && task.amountMinor) {
        await ctx.db.insert("transactions", {
          userId: task.userId,
          accountId: bank._id,
          at: Date.now(),
          amountMinor: -task.amountMinor,
          currency: task.currency,
          merchant: payee?.name ?? task.title,
          category: bill ? (bill.kind === "bill" ? "Bills" : "Subscriptions") : task.channel === "family" ? "Family" : "Payments",
          status: "pending",
          kind: task.channel === "family" ? "transfer" : "spend",
        });
      }
    }
    const amount = task.amountMinor ?? 0;
    const label = formatMoney(amount, task.currency ?? "USDC");
    await ctx.db.insert("activity", {
      userId: task.userId,
      kind: "payment",
      title: handoff ? `You marked ${payee?.name ?? task.title} ${label} as paid` : `Paid ${payee?.name ?? task.title} ${label}`,
      detail: task.rail === "simulator" ? "Simulated payment" : handoff ? "Not confirmed by your bank yet" : undefined,
      tone: handoff ? "neutral" : "good",
    });
    await ctx.db.insert("messages", {
      userId: task.userId,
      role: "assistant",
      text: handoff
        ? `Noted: you paid ${payee?.name ?? task.title} ${label} in your UPI app. I can't confirm it with your bank; it will match when your statement comes in.`
        : `Done. ${payee?.name ?? task.title} has been paid ${label}.`,
      channel: "app",
      taskId,
    });
  },
});
