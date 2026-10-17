import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { errorText } from "./errors";

describe("errors people can read (#74)", () => {
  it("reads a ConvexError's sentence, and the dev-format message of anything else", () => {
    expect(errorText(new ConvexError("That contact is new"))).toBe("That contact is new");
    expect(errorText(new Error("[CONVEX M(x)] [Request ID: 1] Server Error\nUncaught Error: Not found\n  at f"))).toBe("Not found");
    expect(errorText(new Error("[CONVEX M(x)] Server Error\nUncaught ConvexError: Pick 1 to 365 days\n  at f"))).toBe("Pick 1 to 365 days");
  });

  // Production Convex blanks a plain Error's message to "Server Error" before it reaches the app,
  // so a refusal written for a person must be a ConvexError. Only these files may throw plain
  // Errors, for failures that are ours rather than the person's.
  const INTERNAL = new Set(["chain.ts", "migrations.ts", "telegram.ts", "lib/secrets.ts"]);
  it("public code throws refusals as ConvexError", () => {
    const root = join(__dirname, "..");
    const files = [...readdirSync(root).map((f) => f), ...readdirSync(join(root, "lib")).map((f) => `lib/${f}`)].filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !INTERNAL.has(f),
    );
    const offenders = files.filter((f) => readFileSync(join(root, f), "utf8").includes("throw new Error("));
    expect(offenders).toEqual([]);
  });
});
