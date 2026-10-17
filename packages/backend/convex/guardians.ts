import { v } from "convex/values";
import { formatMoney, isVaultVersion } from "@agent-wallet/domain";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireViewer, viewer } from "./lib/auth";
import { freezeAll } from "./lib/control";
import { hit } from "./lib/limits";
import { relayer } from "./lib/relayer";
import { protectMoreTask } from "./lib/actions";

/**
 * A family guardian: someone the owner trusts, with their own account, who sees the owner's held
 * payments and pending assistant requests and can stop them. A guardian can only tighten: cancel a
 * held payment or freeze the assistants. They can never approve, pay, change a limit or see balances,
 * and the owner removes them at once. Meant for elderly users and anyone who wants a second pair of eyes
 * (the CPCA agent-payment convention asks for extra protection for the elderly and minors).
 */

const MAX_GUARDIANS = 3;
const CODE_HOURS = 24;

function inviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

async function linksOf(ctx: QueryCtx, userId: Id<"users">) {
  return (await ctx.db.query("guardians").withIndex("by_user", (q) => q.eq("userId", userId)).take(20)).filter((g) => g.status !== "removed");
}

/** The active link that lets `guardian` look after `owner`, or null. */
async function guarding(ctx: QueryCtx, guardian: Doc<"users">, owner: Id<"users">) {
  const links = await ctx.db.query("guardians").withIndex("by_guardian", (q) => q.eq("guardianId", guardian._id)).take(20);
  return links.find((l) => l.userId === owner && l.status === "active") ?? null;
}

// ---------------------------------------------------------------- the owner

export const invite = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const user = await requireViewer(ctx);
    const label = name.replace(/\s+/g, " ").trim().slice(0, 40);
    if (!label) throw new Error("Add their name");
    await hit(ctx, `guardian-invite:${user._id}`, 10, 3600_000);
    if ((await linksOf(ctx, user._id)).length >= MAX_GUARDIANS) throw new Error(`Up to ${MAX_GUARDIANS} guardians. Remove one first.`);
    const code = inviteCode();
    await ctx.db.insert("guardians", { userId: user._id, name: label, status: "invited", code, codeExpiresAt: Date.now() + CODE_HOURS * 3600_000, createdAt: Date.now() });
    await ctx.db.insert("activity", { userId: user._id, kind: "security", title: `Invited ${label} as a guardian`, detail: `Code works once, for ${CODE_HOURS} hours`, tone: "neutral" });
    return code;
  },
});

/** Instant, from the owner's side: a guardian's access is gone the moment it's removed. */
export const remove = mutation({
  args: { linkId: v.id("guardians") },
  handler: async (ctx, { linkId }) => {
    const user = await requireViewer(ctx);
    const link = await ctx.db.get(linkId);
    if (!link || link.userId !== user._id) throw new Error("Not found");
    await ctx.db.patch(linkId, { status: "removed", code: undefined, codeExpiresAt: undefined });
    await ctx.db.insert("activity", { userId: user._id, kind: "security", title: `Removed ${link.name} as a guardian`, tone: "neutral" });
  },
});

/** Every assistant payment waits longer before it leaves, so a guardian has time to look. Tightening: applies when signed. */
export const protectMore = mutation({
  args: { holdMinutes: v.union(v.literal(10), v.literal(30), v.literal(60)) },
  handler: async (ctx, { holdMinutes }) => {
    const user = await requireViewer(ctx);
    const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    if (!wallet || wallet.status !== "live" || !isVaultVersion(wallet.version)) throw new Error("Put your wallet on-chain first: extra protection is enforced by the vault");
    const { token } = await protectMoreTask(ctx, user, wallet, holdMinutes * 60);
    return token;
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return null;
    const mine = await linksOf(ctx, user._id);
    const guarding_ = (await ctx.db.query("guardians").withIndex("by_guardian", (q) => q.eq("guardianId", user._id)).take(20)).filter((l) => l.status === "active");
    const owners = await Promise.all(guarding_.map((l) => ctx.db.get(l.userId)));
    const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    return {
      guardians: mine.map((g) => ({ _id: g._id, name: g.name, status: g.status, code: g.status === "invited" && (g.codeExpiresAt ?? 0) > Date.now() ? g.code : undefined })),
      protecting: guarding_.map((l, i) => ({ linkId: l._id, ownerId: l.userId, ownerName: owners[i]?.name ?? "Someone" })),
      holdMinutes: wallet?.vault ? Math.round(wallet.vault.holdFor / 60) : null,
    };
  },
});

// ---------------------------------------------------------------- the guardian

export const accept = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const user = await requireViewer(ctx);
    await hit(ctx, `guardian-accept:${user._id}`, 10, 15 * 60_000, "Too many tries. Wait 15 minutes.");
    const clean = code.trim().toUpperCase();
    const link = clean.length === 8 ? await ctx.db.query("guardians").withIndex("by_code", (q) => q.eq("code", clean)).unique() : null;
    if (!link || link.status !== "invited" || (link.codeExpiresAt ?? 0) < Date.now()) throw new Error("That code isn't valid any more. Ask for a new one.");
    if (link.userId === user._id) throw new Error("You can't be your own guardian");
    // One use: the code is gone the moment it's claimed.
    await ctx.db.patch(link._id, { status: "active", guardianId: user._id, code: undefined, codeExpiresAt: undefined, acceptedAt: Date.now() });
    await ctx.db.insert("activity", { userId: link.userId, kind: "security", title: `${link.name} is now your guardian`, detail: "They can cancel held payments and freeze your assistants; they can't pay or change limits", tone: "good" });
    const owner = await ctx.db.get(link.userId);
    return { ownerName: owner?.name ?? "them" };
  },
});

/** What a guardian sees for one person: held payments and assistant requests. No balances, no statements. */
export const watch = query({
  args: { ownerId: v.id("users") },
  handler: async (ctx, { ownerId }) => {
    const user = await viewer(ctx);
    if (!user || !(await guarding(ctx, user, ownerId))) return null;
    const owner = await ctx.db.get(ownerId);
    const tasks = await ctx.db.query("tasks").withIndex("by_user_updated", (q) => q.eq("userId", ownerId)).order("desc").take(60);
    const agentIds = new Set(tasks.map((t) => t.agentId).filter(Boolean));
    const names = new Map<string, string>();
    for (const id of agentIds) {
      const a = await ctx.db.get(id!);
      if (a) names.set(a._id, a.name);
    }
    const payee = async (t: Doc<"tasks">) => (t.payeeId ? ((await ctx.db.get(t.payeeId))?.name ?? "a contact") : "a contact");
    const row = async (t: Doc<"tasks">) => ({
      taskId: t._id,
      agent: t.agentId ? (names.get(t.agentId) ?? "An assistant") : "You",
      payee: await payee(t),
      amount: formatMoney(t.amountMinor ?? 0, t.currency ?? "USDC"),
      state: t.state,
      releaseAt: t.state === "held" ? (t.releaseAt ?? null) : null,
      updatedAt: t.updatedAt,
    });
    const held = await Promise.all(tasks.filter((t) => t.state === "held").map(row));
    const asking = await Promise.all(tasks.filter((t) => t.state === "awaiting_approval" && t.agentId).slice(0, 10).map(row));
    const recent = await Promise.all(tasks.filter((t) => t.agentId && ["confirmed", "cancelled", "failed"].includes(t.state)).slice(0, 10).map(row));
    const agents = await ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", ownerId)).take(50);
    return {
      ownerName: owner?.name ?? "Someone",
      held,
      asking,
      recent,
      assistants: agents.filter((a) => a.provider === "own" || a.status !== "revoked").map((a) => ({ name: a.name, status: a.status })),
    };
  },
});

/** Stop a held payment before it leaves. Uses the vault's guardian action, which can only cancel. */
export const cancelHeld = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const user = await requireViewer(ctx);
    const task = await ctx.db.get(taskId);
    const link = task ? await guarding(ctx, user, task.userId) : null;
    if (!task || !link) throw new Error("Not found");
    if (task.state !== "held") throw new Error("Only a held payment can be stopped");
    await relayer.enqueueAction(ctx, internal.chain.cancelHeld, { taskId });
    await ctx.db.patch(taskId, { reason: `Cancelling… (by ${link.name}, your guardian)`, updatedAt: Date.now() });
    await ctx.db.insert("activity", { userId: task.userId, kind: "security", title: `${link.name} stopped a held payment`, detail: task.title, tone: "warn" });
  },
});

/** Freeze every assistant of the person they look after. Unfreezing stays with the owner's passkey. */
export const freeze = mutation({
  args: { ownerId: v.id("users") },
  handler: async (ctx, { ownerId }) => {
    const user = await requireViewer(ctx);
    const link = await guarding(ctx, user, ownerId);
    if (!link) throw new Error("Not found");
    const owner = (await ctx.db.get(ownerId))!;
    return await freezeAll(ctx, owner, `By ${link.name}, your guardian`);
  },
});

// ---------------------------------------------------------------- alerts

/** Tell each guardian about a held payment: in their own activity, and on Telegram if they linked it. */
export async function alertGuardians(ctx: MutationCtx, task: Doc<"tasks">, text: string) {
  const links = (await ctx.db.query("guardians").withIndex("by_user", (q) => q.eq("userId", task.userId)).take(20)).filter((l) => l.status === "active" && l.guardianId);
  const owner = await ctx.db.get(task.userId);
  for (const l of links) {
    await ctx.db.insert("activity", { userId: l.guardianId!, kind: "security", title: `${owner?.name ?? "Someone you look after"}: ${text}`, detail: "Open Guardian to stop it before it leaves", tone: "warn" });
    if (process.env.TELEGRAM_BOT_TOKEN) await ctx.scheduler.runAfter(0, internal.telegram.send, { userId: l.guardianId!, text: `${owner?.name ?? "Someone you look after"}: ${text} You can stop it in Guardian.` });
  }
}

