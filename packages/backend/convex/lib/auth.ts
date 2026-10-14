import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export const DEMO_TOKEN = "demo";

/** Signed-in user, or the shared demo user when DEMO_MODE is on and nobody is signed in. */
export async function viewer(ctx: QueryCtx | MutationCtx): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  const token = identity?.tokenIdentifier ?? (process.env.DEMO_MODE === "true" ? DEMO_TOKEN : null);
  if (!token) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_token", (q) => q.eq("tokenIdentifier", token))
    .unique();
}

export async function requireViewer(ctx: QueryCtx | MutationCtx): Promise<Doc<"users">> {
  const user = await viewer(ctx);
  if (!user) throw new Error("Not signed in");
  return user;
}

export async function own<T extends { userId: Doc<"users">["_id"] }>(
  user: Doc<"users">,
  doc: T | null,
): Promise<T> {
  if (!doc || doc.userId !== user._id) throw new Error("Not found");
  return doc;
}
