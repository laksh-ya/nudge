import type { MutationCtx } from "../_generated/server";

/**
 * Fixed-window counter. Throws once `key` has been hit `max` times in the current window.
 * Used where abuse costs real resources (relayer gas, approval spam) or guesses a secret.
 */
/** Like `hit`, but reports whether there was room instead of throwing. */
export async function tryHit(ctx: MutationCtx, key: string, max: number, windowMs: number) {
  try {
    await hit(ctx, key, max, windowMs);
    return true;
  } catch {
    return false;
  }
}

export async function hit(ctx: MutationCtx, key: string, max: number, windowMs: number, message = "Too many attempts. Wait a minute and try again.") {
  const now = Date.now();
  const row = await ctx.db.query("limits").withIndex("by_key", (q) => q.eq("key", key)).unique();
  if (!row || now - row.windowStart >= windowMs) {
    if (row) await ctx.db.patch(row._id, { windowStart: now, count: 1 });
    else await ctx.db.insert("limits", { key, windowStart: now, count: 1 });
    return;
  }
  if (row.count >= max) throw new Error(message);
  await ctx.db.patch(row._id, { count: row.count + 1 });
}
