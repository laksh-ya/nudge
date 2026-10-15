import { mutation, query } from "./_generated/server";
import { DEMO_ISSUER, isDemo, isSandbox, viewer } from "./lib/auth";
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
      demo: isDemo(user),
      sandbox: isSandbox(user),
    };
  },
});

/** Called once after sign-in. New accounts start empty and go through setup; demo sandboxes start full. */
export const ensure = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const existing = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();
    if (existing) {
      if (identity.issuer === DEMO_ISSUER) await ctx.db.patch(existing._id, { lastSeenAt: Date.now() });
      return existing._id;
    }
    if (identity.issuer === DEMO_ISSUER) {
      const userId = await ctx.db.insert("users", { ...demoProfile(), tokenIdentifier: identity.tokenIdentifier, lastSeenAt: Date.now() });
      await seedUser(ctx, userId);
      return userId;
    }
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

/** The sample person every demo sandbox starts as. */
export function demoProfile() {
  return {
    name: "Aarav",
    email: "demo@example.com",
    country: "IN",
    currency: "INR" as const,
    timezone: "Asia/Kolkata",
    monthlyBudgetMinor: 4_500_000,
    emergencyMinor: 3_000_000,
    nextIncomeAt: Date.now() + 18 * DAY,
    onboardedAt: Date.now(),
    onboardingStep: undefined,
    autonomy: "limited" as const,
    priorities: ["spending", "bills", "agents", "family"],
  };
}
