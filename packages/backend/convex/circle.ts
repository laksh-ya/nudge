import { v, ConvexError } from "convex/values";
import { formatMoney, isVaultVersion } from "@agent-wallet/domain";
import { getAddress } from "viem";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireViewer, viewer } from "./lib/auth";
import { hit } from "./lib/limits";
import { newApprovalToken } from "./lib/seed";
import { ownerPayTask } from "./lib/actions";
import { credit, month, usedThisMonth, walletOf } from "./lib/circle";
import { maskEmail } from "./guardians";
import { internal } from "./_generated/api";
import { checkInviteEmail, inviteEmail } from "./lib/identity";

/**
 * Family circle. The owner invites someone by link; they accept with their own Nudge account, and
 * from then on can ask for money from their own app. The owner sets a monthly allowance and an
 * amount paid without asking: asks inside both go through at once; anything more waits for the
 * owner (a passkey when the wallet is on-chain). The owner can also just send money.
 */

const DAY = 86_400_000;
const MAX_LINKS = 12;
const RELATIONS = ["Child", "Partner", "Parent", "Sibling", "Grandparent", "Friend", "Other"];

function inviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => alphabet[b % alphabet.length]).join("");
}

function cents(n: number, what: string) {
  if (!Number.isSafeInteger(n) || n < 0 || n > 10_000_000) throw new ConvexError(`${what} must be between $0 and $100,000`);
  return n;
}

async function ownLink(ctx: MutationCtx, user: Doc<"users">, linkId: Id<"familyLinks">) {
  const link = await ctx.db.get(linkId);
  if (!link || link.ownerId !== user._id || link.status === "removed") throw new ConvexError("No such family member");
  return link;
}

function view(link: Doc<"familyLinks">) {
  const used = usedThisMonth(link);
  return {
    _id: link._id,
    name: link.name,
    relation: link.relation,
    status: link.status,
    sample: Boolean(link.sample),
    code: link.status === "invited" && (link.codeExpiresAt ?? 0) > Date.now() ? link.code : undefined,
    allowanceMinor: link.allowanceMinor,
    autoApproveMinor: link.autoApproveMinor,
    usedMinor: used,
    leftMinor: Math.max(0, link.allowanceMinor - used),
    canProtect: Boolean(link.canProtect),
    acceptedAt: link.acceptedAt ?? null,
  };
}

/** Both sides: the people I support, and the people who support me. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return null;
    const links = (await ctx.db.query("familyLinks").withIndex("by_owner", (q) => q.eq("ownerId", user._id)).take(50)).filter((l) => l.status !== "removed");
    const members = await Promise.all(links.map((l) => (l.memberId ? ctx.db.get(l.memberId) : null)));
    const asks = await ctx.db.query("familyAsks").withIndex("by_owner", (q) => q.eq("ownerId", user._id)).order("desc").take(60);
    const names = new Map(links.map((l) => [l._id, l.name]));
    const supporters = (await ctx.db.query("familyLinks").withIndex("by_member", (q) => q.eq("memberId", user._id)).take(20)).filter((l) => l.status === "active");
    const owners = await Promise.all(supporters.map((l) => ctx.db.get(l.ownerId)));
    const myAsks = await ctx.db.query("familyAsks").withIndex("by_member", (q) => q.eq("memberId", user._id)).order("desc").take(40);
    const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", user._id)).unique();
    return {
      wallet: wallet ? { live: wallet.status === "live", balanceMinor: wallet.status === "live" && wallet.vault ? wallet.vault.balanceMinor : wallet.balanceMinor } : null,
      members: links.map((l, i) => ({
        ...view(l),
        account: members[i] ? { name: members[i]!.name || "Their account", email: maskEmail(members[i]!.email) } : null,
      })),
      asks: asks.map((a) => ({ ...a, member: names.get(a.linkId) ?? "Family" })),
      supporters: supporters.map((l, i) => ({
        linkId: l._id,
        ownerName: owners[i]?.name || "Someone",
        ownerEmail: maskEmail(owners[i]?.email),
        allowanceMinor: l.allowanceMinor,
        autoApproveMinor: l.autoApproveMinor,
        leftMinor: Math.max(0, l.allowanceMinor - usedThisMonth(l)),
        canProtect: Boolean(l.canProtect),
      })),
      myAsks,
      relations: RELATIONS,
    };
  },
});

export const invite = mutation({
  args: { name: v.string(), relation: v.string(), email: v.optional(v.string()), allowanceMinor: v.number(), autoApproveMinor: v.number(), canProtect: v.optional(v.boolean()) },
  handler: async (ctx, a) => {
    const user = await requireViewer(ctx);
    await hit(ctx, `family-invite:${user._id}`, 20, 3600_000);
    const name = a.name.trim().replace(/\s+/g, " ").slice(0, 40);
    if (!name) throw new ConvexError("Add their name");
    const relation = RELATIONS.includes(a.relation) ? a.relation : "Other";
    const email = inviteEmail(a.email);
    if (email && email === (user.email ?? "").toLowerCase()) throw new ConvexError("That's your own email");
    const allowance = cents(a.allowanceMinor, "The allowance");
    const auto = cents(a.autoApproveMinor, "The no-questions amount");
    if (auto > allowance) throw new ConvexError("What's paid without asking can't be more than the monthly allowance");
    const open = (await ctx.db.query("familyLinks").withIndex("by_owner", (q) => q.eq("ownerId", user._id)).take(50)).filter((l) => l.status !== "removed");
    if (open.length >= MAX_LINKS) throw new ConvexError(`Up to ${MAX_LINKS} family members. Remove one first.`);
    const code = inviteCode();
    const id = await ctx.db.insert("familyLinks", {
      ownerId: user._id,
      name,
      relation,
      ...(email ? { email } : {}),
      status: "invited",
      code,
      codeExpiresAt: Date.now() + 7 * DAY,
      allowanceMinor: allowance,
      autoApproveMinor: auto,
      usedMinor: 0,
      month: month(),
      canProtect: Boolean(a.canProtect),
      createdAt: Date.now(),
    });
    await ctx.db.insert("activity", { userId: user._id, kind: "setting", title: `Invited ${name} to your family`, detail: `Allowance ${formatMoney(allowance, "USDC")} a month`, tone: "neutral" });
    return { linkId: id, code };
  },
});

/** A fresh link for an invite that expired. */
export const reissue = mutation({
  args: { linkId: v.id("familyLinks") },
  handler: async (ctx, { linkId }) => {
    const user = await requireViewer(ctx);
    const link = await ownLink(ctx, user, linkId);
    if (link.status !== "invited") throw new ConvexError(`${link.name} already joined`);
    const code = inviteCode();
    await ctx.db.patch(link._id, { code, codeExpiresAt: Date.now() + 7 * DAY });
    return code;
  },
});

/** Before accepting: whose family is this? */
export const invitation = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const user = await viewer(ctx);
    if (!user) return null;
    const clean = code.trim().toUpperCase();
    if (clean.length !== 8) return null;
    const link = await ctx.db.query("familyLinks").withIndex("by_code", (q) => q.eq("code", clean)).unique();
    if (!link || link.status !== "invited" || (link.codeExpiresAt ?? 0) < Date.now()) return { valid: false as const };
    const owner = await ctx.db.get(link.ownerId);
    return {
      valid: true as const,
      self: link.ownerId === user._id,
      ownerName: owner?.name || "Someone",
      ownerEmail: maskEmail(owner?.email),
      invitedAs: link.name,
      relation: link.relation,
      allowanceMinor: link.allowanceMinor,
      autoApproveMinor: link.autoApproveMinor,
      canProtect: Boolean(link.canProtect),
    };
  },
});

export const accept = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const user = await requireViewer(ctx);
    await hit(ctx, `family-accept:${user._id}`, 10, 15 * 60_000, "Too many tries. Wait 15 minutes.");
    const clean = code.trim().toUpperCase();
    const link = clean.length === 8 ? await ctx.db.query("familyLinks").withIndex("by_code", (q) => q.eq("code", clean)).unique() : null;
    if (!link || link.status !== "invited" || (link.codeExpiresAt ?? 0) < Date.now()) throw new ConvexError("That invite isn't valid any more. Ask for a new link.");
    if (link.ownerId === user._id) throw new ConvexError("That's your own invite");
    checkInviteEmail(link.email, user.email);
    const already = (await ctx.db.query("familyLinks").withIndex("by_member", (q) => q.eq("memberId", user._id)).take(20)).find((l) => l.ownerId === link.ownerId && l.status === "active");
    if (already) throw new ConvexError("You're already in their family");
    await ctx.db.patch(link._id, { status: "active", memberId: user._id, code: undefined, codeExpiresAt: undefined, acceptedAt: Date.now() });
    // A member who may protect the owner is also their guardian (stop held payments, freeze assistants).
    if (link.canProtect) {
      await ctx.db.insert("guardians", { userId: link.ownerId, name: link.name, guardianId: user._id, status: "active", createdAt: Date.now(), acceptedAt: Date.now() });
    }
    const owner = await ctx.db.get(link.ownerId);
    await ctx.db.insert("activity", { userId: link.ownerId, kind: "security", title: `${link.name} joined your family`, detail: `Signed in as ${user.name || "their own account"}`, tone: "good" });
    return { ownerName: owner?.name || "them" };
  },
});

export const update = mutation({
  args: { linkId: v.id("familyLinks"), allowanceMinor: v.number(), autoApproveMinor: v.number(), relation: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const user = await requireViewer(ctx);
    const link = await ownLink(ctx, user, a.linkId);
    const allowance = cents(a.allowanceMinor, "The allowance");
    const auto = cents(a.autoApproveMinor, "The no-questions amount");
    if (auto > allowance) throw new ConvexError("What's paid without asking can't be more than the monthly allowance");
    await ctx.db.patch(link._id, { allowanceMinor: allowance, autoApproveMinor: auto, ...(a.relation && RELATIONS.includes(a.relation) ? { relation: a.relation } : {}) });
    if (link.memberId) {
      await ctx.db.insert("activity", { userId: link.memberId, kind: "setting", title: `Your allowance is now ${formatMoney(allowance, "USDC")} a month`, tone: "neutral" });
    }
  },
});

export const remove = mutation({
  args: { linkId: v.id("familyLinks") },
  handler: async (ctx, { linkId }) => {
    const user = await requireViewer(ctx);
    const link = await ctx.db.get(linkId);
    // Either side may end it: the owner removes, the member leaves.
    if (!link || (link.ownerId !== user._id && link.memberId !== user._id)) throw new ConvexError("No such family link");
    await ctx.db.patch(link._id, { status: "removed", code: undefined, codeExpiresAt: undefined });
    for (const ask of await ctx.db.query("familyAsks").withIndex("by_link", (q) => q.eq("linkId", link._id)).take(100)) {
      if (ask.state === "waiting") await ctx.db.patch(ask._id, { state: "declined", decidedAt: Date.now() });
    }
    await ctx.db.insert("activity", { userId: link.ownerId, kind: "setting", title: link.ownerId === user._id ? `Removed ${link.name} from your family` : `${link.name} left your family`, tone: "neutral" });
  },
});

/**
 * Pay a family ask or send. Inside the allowance and the no-questions amount: at once (simulated
 * wallets move in the app's ledger). Otherwise: an approval for the owner; on an on-chain wallet that
 * is a passkey-signed vault payment to the member's own vault.
 */
async function pay(ctx: MutationCtx, link: Doc<"familyLinks">, ask: Doc<"familyAsks">, ownerAsked: boolean) {
  const ownerWallet = await walletOf(ctx, link.ownerId);
  if (!ownerWallet) throw new ConvexError(ownerAsked ? "Set up your Nudge wallet first (Wallet screen)" : "They haven't set up a Nudge wallet yet");
  if (ownerWallet.frozen || ownerWallet.vault?.frozen) throw new ConvexError("The wallet is frozen");
  const live = ownerWallet.status === "live" && isVaultVersion(ownerWallet.version);
  const used = usedThisMonth(link);
  const inside = !ownerAsked && ask.amountMinor <= link.autoApproveMinor && used + ask.amountMinor <= link.allowanceMinor;
  const free = live && ownerWallet.vault ? ownerWallet.vault.balanceMinor - ownerWallet.vault.heldMinor : ownerWallet.balanceMinor;
  if (free < ask.amountMinor) throw new ConvexError(ownerAsked ? "Not enough in your Nudge wallet" : "Not enough in their wallet right now");

  if (!live && (inside || ownerAsked)) {
    // The owner sending is the owner's own yes; an ask inside the allowance was pre-approved by them.
    await ctx.db.patch(ask._id, { auto: inside });
    await credit(ctx, link, { ...ask, auto: inside }, { debitOwner: true });
    return { state: "paid" as const };
  }

  const memberWallet = link.memberId ? await walletOf(ctx, link.memberId) : null;
  const title = ask.kind === "send" ? `Send ${link.name} ${formatMoney(ask.amountMinor, "USDC")}` : `${link.name} asks for ${formatMoney(ask.amountMinor, "USDC")}`;
  const reason = ask.kind === "send" ? "Family payment from your wallet" : inside ? "Inside their allowance; your vault still needs your passkey" : `Above ${link.name}'s no-questions amount or monthly allowance`;
  let taskId: Id<"tasks">;
  if (live && memberWallet?.address) {
    // To the member's own vault, signed by the owner's passkey.
    const payees = await ctx.db.query("payees").withIndex("by_user", (q) => q.eq("userId", link.ownerId)).take(200);
    let payee = payees.find((p) => p.address?.toLowerCase() === memberWallet.address.toLowerCase());
    if (!payee) {
      const id = await ctx.db.insert("payees", { userId: link.ownerId, name: link.name, handle: "family", kind: "person", trusted: false, address: getAddress(memberWallet.address), onchain: false, addedAt: Date.now() });
      payee = (await ctx.db.get(id))!;
    }
    const owner = (await ctx.db.get(link.ownerId))!;
    taskId = (await ownerPayTask(ctx, { user: owner, payee, amountMinor: ask.amountMinor, title, channel: "family", purpose: ask.note, reason })).taskId;
  } else {
    taskId = await ctx.db.insert("tasks", {
      userId: link.ownerId,
      title,
      channel: "family",
      amountMinor: ask.amountMinor,
      currency: "USDC",
      purpose: ask.note,
      state: "awaiting_approval",
      reason: live ? `${reason}. ${link.name} has no on-chain wallet yet, so this is settled in the app` : reason,
      rail: "simulator",
      approvalToken: newApprovalToken(),
      expiresAt: Date.now() + 7 * DAY,
      updatedAt: Date.now(),
    });
  }
  await ctx.db.patch(ask._id, { state: "approval", taskId });
  return { state: "approval" as const, taskId };
}

/** The member asks for money from their own account. */
export const ask = mutation({
  args: { linkId: v.id("familyLinks"), amountMinor: v.number(), note: v.string() },
  handler: async (ctx, a) => {
    const user = await requireViewer(ctx);
    await hit(ctx, `family-ask:${user._id}`, 20, 3600_000);
    const link = await ctx.db.get(a.linkId);
    if (!link || link.memberId !== user._id || link.status !== "active") throw new ConvexError("You're not in that family any more");
    if (!Number.isSafeInteger(a.amountMinor) || a.amountMinor < 1 || a.amountMinor > 10_000_000) throw new ConvexError("Ask for a positive amount");
    const note = a.note.trim().replace(/\s+/g, " ").slice(0, 120) || "No note";
    const id = await ctx.db.insert("familyAsks", { linkId: link._id, ownerId: link.ownerId, memberId: user._id, kind: "ask", amountMinor: a.amountMinor, note, state: "waiting", createdAt: Date.now() });
    const r = await pay(ctx, link, (await ctx.db.get(id))!, false);
    if (r.state === "approval") {
      await ctx.db.insert("activity", { userId: link.ownerId, kind: "payment", title: `${link.name} asked for ${formatMoney(a.amountMinor, "USDC")}`, detail: note, tone: "warn" });
      await ctx.scheduler.runAfter(0, internal.telegram.send, { userId: link.ownerId, text: `${link.name} asks for ${formatMoney(a.amountMinor, "USDC")}: ${note}. Open Nudge → Family to answer.` });
    }
    return r.state;
  },
});

/** The owner sends money to a member (always their own yes; a passkey on an on-chain wallet). */
export const send = mutation({
  args: { linkId: v.id("familyLinks"), amountMinor: v.number(), note: v.string() },
  handler: async (ctx, a) => {
    const user = await requireViewer(ctx);
    const link = await ownLink(ctx, user, a.linkId);
    if (link.status !== "active" && !link.sample) throw new ConvexError(`${link.name} hasn't joined yet`);
    if (!Number.isSafeInteger(a.amountMinor) || a.amountMinor < 1 || a.amountMinor > 10_000_000) throw new ConvexError("Enter an amount");
    const note = a.note.trim().replace(/\s+/g, " ").slice(0, 120) || "From you";
    const id = await ctx.db.insert("familyAsks", { linkId: link._id, ownerId: user._id, memberId: link.memberId, kind: "send", amountMinor: a.amountMinor, note, state: "waiting", createdAt: Date.now() });
    const r = await pay(ctx, link, (await ctx.db.get(id))!, true);
    if (r.state === "approval") return (await ctx.db.get(r.taskId!))!.approvalToken ?? null;
    return null;
  },
});

/** The owner answers an ask that needed them: decline, or approve (the approval card does the rest). */
export const decline = mutation({
  args: { askId: v.id("familyAsks") },
  handler: async (ctx, { askId }) => {
    const user = await requireViewer(ctx);
    const a = await ctx.db.get(askId);
    if (!a || a.ownerId !== user._id) throw new ConvexError("No such request");
    if (a.state !== "approval" && a.state !== "waiting") return a.state;
    if (a.taskId) {
      const task = await ctx.db.get(a.taskId);
      if (task?.state === "awaiting_approval") await ctx.db.patch(task._id, { state: "cancelled", approvalToken: undefined, updatedAt: Date.now() });
    }
    await ctx.db.patch(a._id, { state: "declined", decidedAt: Date.now() });
    if (a.memberId) await ctx.db.insert("activity", { userId: a.memberId, kind: "payment", title: `Your request for ${formatMoney(a.amountMinor, "USDC")} was declined`, detail: a.note, tone: "neutral" });
    return "declined";
  },
});

/** The approval link for an ask that needs the owner. */
export const approvalFor = query({
  args: { askId: v.id("familyAsks") },
  handler: async (ctx, { askId }) => {
    const user = await viewer(ctx);
    const a = await ctx.db.get(askId);
    if (!user || !a || a.ownerId !== user._id || !a.taskId) return null;
    const task = await ctx.db.get(a.taskId);
    return task?.state === "awaiting_approval" ? { token: task.approvalToken ?? null, live: Boolean(task.action) } : null;
  },
});
