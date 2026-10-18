import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Delete everything a user owns except the user row itself. */
export async function wipeUser(ctx: MutationCtx, userId: Id<"users">) {
  const batches = await Promise.all([
    ctx.db.query("accounts").withIndex("by_user", (q) => q.eq("userId", userId)).take(500),
    ctx.db.query("transactions").withIndex("by_user_at", (q) => q.eq("userId", userId)).take(4000),
    ctx.db.query("imports").withIndex("by_user", (q) => q.eq("userId", userId)).take(1000),
    ctx.db.query("rules").withIndex("by_user_key", (q) => q.eq("userId", userId)).take(1000),
    ctx.db.query("obligations").withIndex("by_user_due", (q) => q.eq("userId", userId)).take(500),
    ctx.db.query("goals").withIndex("by_user", (q) => q.eq("userId", userId)).take(500),
    ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", userId)).take(10),
    ctx.db.query("payees").withIndex("by_user", (q) => q.eq("userId", userId)).take(500),
    ctx.db.query("agents").withIndex("by_user", (q) => q.eq("userId", userId)).take(500),
    ctx.db.query("tasks").withIndex("by_user_updated", (q) => q.eq("userId", userId)).take(2000),
    ctx.db.query("messages").withIndex("by_user", (q) => q.eq("userId", userId)).take(2000),
    ctx.db.query("family").withIndex("by_user", (q) => q.eq("userId", userId)).take(500),
    ctx.db.query("familyRequests").withIndex("by_user", (q) => q.eq("userId", userId)).take(500),
    ctx.db.query("activity").withIndex("by_user", (q) => q.eq("userId", userId)).take(2000),
    ctx.db.query("chatLinks").withIndex("by_user", (q) => q.eq("userId", userId)).take(20),
    ctx.db.query("guardians").withIndex("by_user", (q) => q.eq("userId", userId)).take(20),
    // Links where this user looks after someone else go too, so a deleted account guards no one.
    ctx.db.query("guardians").withIndex("by_guardian", (q) => q.eq("guardianId", userId)).take(20),
    ctx.db.query("familyLinks").withIndex("by_owner", (q) => q.eq("ownerId", userId)).take(100),
    ctx.db.query("familyAsks").withIndex("by_owner", (q) => q.eq("ownerId", userId)).take(1000),
    ctx.db.query("plans").withIndex("by_user_due", (q) => q.eq("userId", userId)).take(500),
    ctx.db.query("watches").withIndex("by_user", (q) => q.eq("userId", userId)).take(500),
  ]);
  const holdings = [];
  for (const a of batches[0]) holdings.push(...(await ctx.db.query("holdings").withIndex("by_account", (q) => q.eq("accountId", a._id)).take(500)));
  for (const a of batches[8]) holdings.push(...(await ctx.db.query("agentKeys").withIndex("by_agent", (q) => q.eq("agentId", a._id)).take(10)));
  for (const batch of [...batches, holdings]) for (const doc of batch) await ctx.db.delete(doc._id);
}
