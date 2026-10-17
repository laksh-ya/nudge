import { ConvexError } from "convex/values";
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

export const JUDGE_READ_ONLY = "This is the team's demo account, so it's read-only. Open your own sandbox to try changes.";

/** The judge account is shared by everyone with the judge link; only the team's admin token may change it. */
export async function judgeReadOnly(ctx: QueryCtx | MutationCtx, user: Pick<Doc<"users">, "tokenIdentifier">) {
  if (user.tokenIdentifier !== JUDGE) return false;
  const identity = await ctx.auth.getUserIdentity();
  return identity?.judgeAdmin !== true;
}

export async function requireViewer(ctx: QueryCtx | MutationCtx): Promise<Doc<"users">> {
  const user = await viewer(ctx);
  if (!user) throw new ConvexError("Not signed in");
  // Every public mutation starts here, so this one check keeps visitors from changing the judge account.
  if ("insert" in ctx.db && (await judgeReadOnly(ctx, user))) throw new ConvexError(JUDGE_READ_ONLY);
  return user;
}

export async function own<T extends { userId: Doc<"users">["_id"] }>(
  user: Doc<"users">,
  doc: T | null,
): Promise<T> {
  if (!doc || doc.userId !== user._id) throw new ConvexError("Not found");
  return doc;
}
