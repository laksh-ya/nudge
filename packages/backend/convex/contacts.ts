import { v, ConvexError } from "convex/values";
import { isVaultVersion } from "@agent-wallet/domain";
import { getAddress, isAddress, zeroAddress } from "viem";
import { mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { own, requireViewer } from "./lib/auth";
import { addContactTask, removeContactTask } from "./lib/actions";
import { hit } from "./lib/limits";

/**
 * Contacts the owner adds and removes (issue #10). Agents can only ever pay saved contacts.
 * Adding loosens what agents may do, so on a live vault it needs the passkey and then the vault's
 * waiting period; removing only tightens, so it takes effect in the app at once.
 */

async function walletOf(ctx: MutationCtx, userId: Id<"users">) {
  return await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
}

const isLive = (w: Doc<"wallets"> | null): w is Doc<"wallets"> => w?.status === "live";

/** Any change that can add or change this contact must stop before the app forgets it. */
function changesContact(task: Doc<"tasks">, payeeId: Id<"payees">) {
  return Boolean(task.effects?.payees.includes(payeeId) || task.effects?.contactCap?.payeeId === payeeId);
}

async function changingOnChain(ctx: MutationCtx, userId: Id<"users">, payeeId: Id<"payees">) {
  for (const state of ["reserved", "submitted", "queued", "unknown"] as const) {
    const tasks = await ctx.db.query("tasks").withIndex("by_user_state", (q) => q.eq("userId", userId).eq("state", state)).collect();
    if (tasks.some((t) => changesContact(t, payeeId))) return true;
  }
  return false;
}

/** The open passkey approval that adds this one contact, if there is one. */
async function pendingAdd(ctx: MutationCtx, user: Doc<"users">, payeeId: Id<"payees">) {
  const waiting = await ctx.db
    .query("tasks")
    .withIndex("by_user_state", (q) => q.eq("userId", user._id).eq("state", "awaiting_approval"))
    .collect();
  return waiting.filter((t) => t.effects?.payees.includes(payeeId) && t.effects.agents.length === 0);
}

export const add = mutation({
  args: { name: v.string(), address: v.string(), kind: v.optional(v.union(v.literal("person"), v.literal("merchant"))) },
  handler: async (ctx, args) => await addContactFor(ctx, await requireViewer(ctx), args),
});

/** The owner adds a contact: from the Wallet screen or the chat. On a live vault it ends in a passkey approval. */
export async function addContactFor(ctx: MutationCtx, user: Doc<"users">, args: { name: string; address: string; kind?: "person" | "merchant" }) {
    await hit(ctx, `contact-add:${user._id}`, 10, 60_000);
    const name = args.name.trim().replace(/\s+/g, " ");
    if (!name || name.length > 40) throw new ConvexError("Give the contact a name, up to 40 characters");
    const raw = args.address.trim();
    if (!isAddress(raw, { strict: false })) throw new ConvexError("That isn't a wallet address. It starts with 0x followed by 40 letters and digits.");
    // Mixed case carries a checksum; a typo in it means the address was copied wrong.
    if (raw !== raw.toLowerCase() && raw.slice(2) !== raw.slice(2).toUpperCase() && !isAddress(raw)) {
      throw new ConvexError("That address's capital letters don't match its checksum. Copy it again.");
    }
    const address = getAddress(raw);
    if (address === zeroAddress) throw new ConvexError("That address can't receive payments");

    const w = await walletOf(ctx, user._id);
    if (w?.address && w.address.toLowerCase() === address.toLowerCase()) throw new ConvexError("That's your own wallet");
    if (isLive(w) && !isVaultVersion(w.version)) throw new ConvexError("Move to the current vault first (Wallet screen)");
    const payees = await ctx.db.query("payees").withIndex("by_user", (q) => q.eq("userId", user._id)).take(200);
    if (payees.length >= 200) throw new ConvexError("You have 200 contacts already. Remove one first.");
    const sameAddress = payees.find((p) => p.address?.toLowerCase() === address.toLowerCase());
    if (sameAddress) throw new ConvexError(`That address is already saved as ${sameAddress.name}`);
    if (payees.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new ConvexError(`You already have a contact called ${name}`);

    const simDelay = w?.rules?.contactDelay ?? 0;
    const live = isLive(w);
    const payeeId = await ctx.db.insert("payees", {
      userId: user._id,
      name,
      handle: `${address.slice(0, 6)}…${address.slice(-4)}`,
      kind: args.kind ?? "person",
      // A simulated wallet has no vault to wait on. On a live vault the passkey and the vault's
      // waiting period come first; the contact becomes trusted when the vault has it.
      trusted: !live,
      address,
      onchain: false,
      addedAt: Date.now(),
      // A simulated wallet honours the owner's own new-contact wait (Wallet → Rules and limits).
      ...(live ? { pendingPasskey: true } : simDelay ? { activeAt: Date.now() + simDelay * 1000 } : {}),
    });
    await ctx.db.insert("activity", {
      userId: user._id,
      kind: "setting",
      title: `Added ${name} to your contacts`,
      detail: live ? "Waiting for your passkey, then the vault's waiting period" : "Simulated wallet: agents can pay it now",
      tone: "neutral",
    });
    if (!live) return { payeeId, token: null };
    const { token } = await addContactTask(ctx, user, (await ctx.db.get(payeeId))!, w);
    return { payeeId, token };
}

/** The passkey link for a contact still waiting to be added to the vault; a fresh one if the last expired or was declined. */
export const approveAdd = mutation({
  args: { payeeId: v.id("payees") },
  handler: async (ctx, { payeeId }) => {
    const user = await requireViewer(ctx);
    const payee = await own(user, await ctx.db.get(payeeId));
    if (!payee.pendingPasskey) throw new ConvexError(`${payee.name} is already in your vault`);
    const w = await walletOf(ctx, user._id);
    if (!isLive(w) || !isVaultVersion(w.version)) throw new ConvexError("Your wallet isn't on-chain");
    if (await changingOnChain(ctx, user._id, payeeId)) throw new ConvexError("This contact's approval is already being applied. Wait for it to finish.");
    const open = (await pendingAdd(ctx, user, payeeId)).find((t) => (t.expiresAt ?? 0) > Date.now() && t.approvalToken);
    if (open) return open.approvalToken!;
    await hit(ctx, `contact-add:${user._id}`, 10, 60_000);
    return (await addContactTask(ctx, user, payee, w)).token;
  },
});

export const remove = mutation({
  args: { payeeId: v.id("payees") },
  handler: async (ctx, { payeeId }) => {
    const user = await requireViewer(ctx);
    const payee = await own(user, await ctx.db.get(payeeId));
    const w = await walletOf(ctx, user._id);
    // Once signed, an add/cap change may still land in the vault. Keep the record until it
    // settles, so removal can include the correct on-chain RemoveContact approval.
    if (await changingOnChain(ctx, user._id, payeeId)) throw new ConvexError("A signed change to this contact is still being applied. Wait for it to finish, then remove the contact.");
    // Requests still asking for approval to pay it, or to add/change it, stop now.
    const waiting = await ctx.db
      .query("tasks")
      .withIndex("by_user_state", (q) => q.eq("userId", user._id).eq("state", "awaiting_approval"))
      .collect();
    for (const t of waiting) {
      if (t.payeeId === payeeId || changesContact(t, payeeId)) {
        await ctx.db.patch(t._id, { state: "cancelled", approvalToken: undefined, reason: `${payee.name} was removed from your contacts`, updatedAt: Date.now() });
      }
    }
    // In the vault it stays payable until the passkey removes it there too; offer that at once.
    const token = isLive(w) && isVaultVersion(w.version) && payee.onchain ? (await removeContactTask(ctx, user, payee)).token : null;
    await ctx.db.delete(payeeId);
    await ctx.db.insert("activity", {
      userId: user._id,
      kind: "setting",
      title: `Removed ${payee.name} from your contacts`,
      detail: token ? "Agents can't ask to pay it. Approve with your passkey to take it out of the vault too." : "Agents can't pay it any more",
      tone: "neutral",
    });
    return { token };
  },
});
