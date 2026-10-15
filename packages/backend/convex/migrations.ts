import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { JUDGE } from "./lib/auth";
import { isSealed, open, seal } from "./lib/secrets";

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

/** 15 Oct 2026: the old shared demo user (with the phone vault) becomes the private judge account. */
export const judgeAccount = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db.query("users").withIndex("by_token", (q) => q.eq("tokenIdentifier", "demo")).unique();
    if (!old) return null;
    await ctx.db.patch(old._id, { tokenIdentifier: JUDGE });
    return old._id;
  },
});

/** Seal any agent key stored before encryption. Safe to run more than once. */
export const sealAgentKeys = internalAction({
  args: {},
  handler: async (ctx): Promise<number> => {
    const rows: { _id: Id<"agentKeys">; agentId: Id<"agents">; privateKey: string }[] = await ctx.runQuery(internal.migrations.plainAgentKeys, {});
    for (const r of rows) await ctx.runMutation(internal.migrations.replaceAgentKey, { id: r._id, privateKey: await seal(r.privateKey, r.agentId) });
    return rows.length;
  },
});

export const plainAgentKeys = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("agentKeys").take(500)).filter((k) => !isSealed(k.privateKey)),
});

export const replaceAgentKey = internalMutation({
  args: { id: v.id("agentKeys"), privateKey: v.string() },
  handler: async (ctx, { id, privateKey }) => {
    await ctx.db.patch(id, { privateKey });
  },
});

/**
 * Test-only: hand an agent's key to the end-to-end test so it can play an attacker who stole it.
 * Refuses unless the deployment sets ALLOW_KEY_REVEAL=true (dev only, never production).
 */
export const revealAgentKeyForTest = internalAction({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }): Promise<string> => {
    if (process.env.ALLOW_KEY_REVEAL !== "true") throw new Error("Not on this deployment");
    const row: { privateKey: string } | null = await ctx.runQuery(internal.migrations.agentKeyRow, { agentId });
    if (!row) throw new Error("No key");
    return await open(row.privateKey, agentId);
  },
});

export const agentKeyRow = internalQuery({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => await ctx.db.query("agentKeys").withIndex("by_agent", (q) => q.eq("agentId", agentId)).unique(),
});

/** 15 Oct 2026: label the judge account's seeded history, which predates sample labels. */
export const labelJudgeSamples = internalMutation({
  args: {},
  handler: async (ctx) => {
    const judge = await ctx.db.query("users").withIndex("by_token", (q) => q.eq("tokenIdentifier", JUDGE)).unique();
    if (!judge) return 0;
    const seeded = new Set(["OpenClaw frozen", "Paid Blue Tokai $8.40", "Imported your HDFC statement", "Claude connected", "Signed in on a new device", "Protected $50 in your wallet"]);
    let n = 0;
    for (const t of await ctx.db.query("tasks").withIndex("by_user_updated", (q) => q.eq("userId", judge._id)).take(300)) {
      if (t.rail !== "base-sepolia" && !t.sample) {
        await ctx.db.patch(t._id, { sample: true });
        n++;
      }
    }
    for (const a of await ctx.db.query("activity").withIndex("by_user", (q) => q.eq("userId", judge._id)).take(500)) {
      if (seeded.has(a.title) && !a.sample) {
        await ctx.db.patch(a._id, { sample: true });
        n++;
      }
    }
    return n;
  },
});
