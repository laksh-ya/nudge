import { internalMutation } from "./_generated/server";

/** 15 Oct 2026: "upi" accounts become payment apps; users created before onboarding count as set up. */
export const accountKinds = internalMutation({
  args: {},
  handler: async (ctx) => {
    let accounts = 0;
    for (const a of await ctx.db.query("accounts").take(5000)) {
      const patch: Record<string, unknown> = {};
      if ((a.kind as string) === "upi") patch.kind = "payment_app";
      if (!a.status) patch.status = "ok";
      if (Object.keys(patch).length) {
        await ctx.db.patch(a._id, patch);
        accounts++;
      }
    }
    let users = 0;
    for (const u of await ctx.db.query("users").take(5000)) {
      const patch: Record<string, unknown> = {};
      if (u.country === "India") patch.country = "IN";
      if (!u.onboardedAt && !u.onboardingStep) patch.onboardedAt = u._creationTime;
      if (Object.keys(patch).length) {
        await ctx.db.patch(u._id, patch);
        users++;
      }
    }
    return { accounts, users };
  },
});
