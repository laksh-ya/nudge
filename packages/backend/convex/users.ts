import { internalMutation, mutation, query } from "./_generated/server";
import { DEMO_TOKEN, viewer } from "./lib/auth";
import { seedUser } from "./lib/seed";
import type { MutationCtx } from "./_generated/server";

const DAY = 86_400_000;

async function createUser(ctx: MutationCtx, tokenIdentifier: string, name: string, email?: string) {
  const userId = await ctx.db.insert("users", {
    tokenIdentifier,
    name,
    email,
    country: "India",
    currency: "INR",
    monthlyBudgetMinor: 4_500_000,
    emergencyMinor: 3_000_000,
    nextIncomeAt: Date.now() + 18 * DAY,
  });
  await seedUser(ctx, userId);
  return userId;
}

export const me = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return null;
    return { _id: user._id, name: user.name, email: user.email, currency: user.currency, country: user.country };
  },
});

/** Called once after sign-in. New accounts start with sample data. */
export const ensure = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const existing = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();
    if (existing) return existing._id;
    return await createUser(
      ctx,
      identity.tokenIdentifier,
      identity.givenName ?? identity.name?.split(" ")[0] ?? "there",
      identity.email,
    );
  },
});

export const seedDemo = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", DEMO_TOKEN))
      .unique();
    if (existing) return existing._id;
    return await createUser(ctx, DEMO_TOKEN, "Aarav", "demo@example.com");
  },
});
