import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Demo visitors get a private sandbox: the web app signs a short-lived token for a random id kept
 * in a cookie, so nobody can see or change anyone else's demo. The judge account is the same
 * kind of token with a fixed id, issued only to someone holding the judge key.
 */
export const DEMO_ISSUER = "https://demo.agent-wallet.app";
export const JUDGE = `${DEMO_ISSUER}|judge`;

export function isDemo(user: Pick<Doc<"users">, "tokenIdentifier">) {
  return user.tokenIdentifier.startsWith(`${DEMO_ISSUER}|`);
}

/** A sandbox anyone can make; the judge account is not one. */
export function isSandbox(user: Pick<Doc<"users">, "tokenIdentifier">) {
  return isDemo(user) && user.tokenIdentifier !== JUDGE;
}

export async function viewer(ctx: QueryCtx | MutationCtx): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
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
