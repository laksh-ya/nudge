import { v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { DEMO_ISSUER, JUDGE, isSandbox, viewer } from "./lib/auth";
import { seedUser } from "./lib/seed";
import { wipeUser } from "./lib/wipe";
import { demoProfile } from "./users";

const DAY = 86_400_000;

async function resetDemo(ctx: MutationCtx, userId: Id<"users">) {
  await wipeUser(ctx, userId);
  await ctx.db.patch(userId, demoProfile());
  await seedUser(ctx, userId);
  return userId;
}

/** Start your own sandbox over. The judge account can't be reset from the app: it holds the real vault. */
export const restore = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user || !isSandbox(user)) throw new Error("Only a demo sandbox can be restored");
    return await resetDemo(ctx, user._id);
  },
});

/** Operator reset for one account, from the CLI. */
export const reset = internalMutation({
  args: { tokenIdentifier: v.string() },
  handler: async (ctx, { tokenIdentifier }) => {
    const user = await ctx.db.query("users").withIndex("by_token", (q) => q.eq("tokenIdentifier", tokenIdentifier)).unique();
    return user ? await resetDemo(ctx, user._id) : null;
  },
});

/** Sandboxes nobody has opened for two days are deleted. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const sandboxes = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.gt("tokenIdentifier", `${DEMO_ISSUER}|`).lt("tokenIdentifier", `${DEMO_ISSUER}|~`))
      .take(50);
    let removed = 0;
    for (const u of sandboxes) {
      if (u.tokenIdentifier === JUDGE || (u.lastSeenAt ?? u._creationTime) > Date.now() - 2 * DAY) continue;
      const wallet = await ctx.db.query("wallets").withIndex("by_user", (q) => q.eq("userId", u._id)).unique();
      if (wallet?.address) continue; // keep anything with a real vault
      await wipeUser(ctx, u._id);
      await ctx.db.delete(u._id);
      removed++;
    }
    return removed;
  },
});
