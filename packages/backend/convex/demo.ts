import { internalMutation, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { DEMO_TOKEN, viewer } from "./lib/auth";
import { seedUser } from "./lib/seed";
import { wipeUser } from "./lib/wipe";

async function resetDemo(ctx: MutationCtx) {
    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", DEMO_TOKEN))
      .unique();
    if (!user) return null;
    await wipeUser(ctx, user._id);
    await ctx.db.patch(user._id, {
      name: "Aarav",
      country: "IN",
      currency: "INR",
      timezone: "Asia/Kolkata",
      nextIncomeAt: Date.now() + 18 * 86_400_000,
      monthlyBudgetMinor: 4_500_000,
      emergencyMinor: 3_000_000,
      onboardingStep: undefined,
      onboardedAt: Date.now(),
      autonomy: "limited",
      priorities: ["spending", "bills", "agents", "family"],
    });
    await seedUser(ctx, user._id);
    return user._id;
}

/** Puts the shared demo account back to its starting state. */
export const reset = internalMutation({ args: {}, handler: async (ctx) => resetDemo(ctx) });

/** Same, callable from the app, but only while using the demo account. */
export const restore = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user || user.tokenIdentifier !== DEMO_TOKEN) throw new Error("Only the demo account can be restored");
    return await resetDemo(ctx);
  },
});
