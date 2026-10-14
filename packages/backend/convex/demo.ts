import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { DEMO_TOKEN } from "./lib/auth";
import { seedUser } from "./lib/seed";

async function wipe(ctx: MutationCtx, userId: Id<"users">) {
  const batches = await Promise.all([
    ctx.db.query("accounts").withIndex("by_user", (q) => q.eq("userId", userId)).take(500),
    ctx.db.query("transactions").withIndex("by_user_at", (q) => q.eq("userId", userId)).take(2000),
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
  ]);
  for (const batch of batches) for (const doc of batch) await ctx.db.delete(doc._id);
}

/** Puts the shared demo account back to its starting state. */
export const reset = internalMutation({
  args: {},
  handler: async (ctx) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", DEMO_TOKEN))
      .unique();
    if (!user) return null;
    await wipe(ctx, user._id);
    await ctx.db.patch(user._id, { nextIncomeAt: Date.now() + 18 * 86_400_000 });
    await seedUser(ctx, user._id);
    return user._id;
  },
});
