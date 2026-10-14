import { internalMutation, mutation, query } from "./_generated/server";
import { DEMO_TOKEN, viewer } from "./lib/auth";
import { seedUser } from "./lib/seed";

const DAY = 86_400_000;

export const me = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return null;
    return {
      _id: user._id,
      name: user.name,
      email: user.email,
      currency: user.currency,
      country: user.country,
      timezone: user.timezone,
      onboarded: Boolean(user.onboardedAt),
      onboardingStep: user.onboardingStep ?? null,
      demo: user.tokenIdentifier === DEMO_TOKEN,
    };
  },
});

/** Called once after sign-in. New accounts start empty and go through setup. */
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
    return await ctx.db.insert("users", {
      tokenIdentifier: identity.tokenIdentifier,
      name: identity.givenName ?? identity.name?.split(" ")[0] ?? "",
      email: identity.email,
      country: "IN",
      currency: "INR",
      monthlyBudgetMinor: 0,
      emergencyMinor: 0,
      nextIncomeAt: Date.now() + 30 * DAY,
      onboardingStep: "you",
    });
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
    const userId = await ctx.db.insert("users", {
      tokenIdentifier: DEMO_TOKEN,
      name: "Aarav",
      email: "demo@example.com",
      country: "IN",
      currency: "INR",
      timezone: "Asia/Kolkata",
      monthlyBudgetMinor: 4_500_000,
      emergencyMinor: 3_000_000,
      nextIncomeAt: Date.now() + 18 * DAY,
      onboardedAt: Date.now(),
      autonomy: "limited",
      priorities: ["spending", "bills", "agents", "family"],
    });
    await seedUser(ctx, userId);
    return userId;
  },
});
