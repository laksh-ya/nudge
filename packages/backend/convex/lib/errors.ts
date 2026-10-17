import { ConvexError } from "convex/values";

/**
 * The sentence a person should read from a thrown error. User-facing refusals are ConvexErrors,
 * because production Convex replaces a plain Error's message with "Server Error" before it leaves
 * the deployment; a ConvexError's data is kept.
 */
export function errorText(e: unknown, max = 200): string {
  if (e instanceof ConvexError && typeof e.data === "string") return e.data.slice(0, max);
  const m = e instanceof Error ? e.message : String(e);
  return (m.match(/Uncaught (?:Convex)?Error: ([^\n]+)/)?.[1] ?? m).slice(0, max);
}
