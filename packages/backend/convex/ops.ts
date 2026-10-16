import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";

/** Alert the operator once runway falls below this many sandboxes, at most every six hours. */
const ALERT_BELOW = 50;
const ALERT_EVERY = 6 * 3_600_000;

/** Store a runway reading (from chain.checkRunway) and warn the operator when it runs low. */
export const record = internalMutation({
  args: { address: v.string(), balancesWei: v.array(v.string()), perSandboxWei: v.string(), runway: v.number() },
  handler: async (ctx, a) => {
    const row = await ctx.db.query("ops").withIndex("by_key", (q) => q.eq("key", "relayer")).unique();
    const now = Date.now();
    const low = a.runway < ALERT_BELOW;
    const alert = low && (!row?.alertedAt || now - row.alertedAt > ALERT_EVERY);
    const next = { key: "relayer" as const, ...a, checkedAt: now, alertedAt: alert ? now : low ? row?.alertedAt : undefined };
    if (row) await ctx.db.replace(row._id, next);
    else await ctx.db.insert("ops", next);
    if (!alert) return;
    const text = `Demo relayer ${a.address} has test ETH for about ${a.runway} more sandboxes. Top it up from a Base Sepolia faucet.`;
    console.warn(text);
    const chatId = process.env.OPS_TELEGRAM_CHAT_ID;
    if (chatId) await ctx.scheduler.runAfter(0, internal.telegram.send, { chatId, text });
  },
});

/** `npx convex run ops:status` */
export const status = internalQuery({
  args: {},
  handler: async (ctx) => await ctx.db.query("ops").withIndex("by_key", (q) => q.eq("key", "relayer")).unique(),
});
