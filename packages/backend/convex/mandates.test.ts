/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

// get_mandate: an assistant can show what the owner allowed it to do, once the vault enforces it.
vi.mock("./lib/relayer", () => {
  const pool = { enqueueAction: vi.fn(async () => "queued") };
  return { relayer: pool, agentPool: pool, lanePool: () => pool, laneOf: () => 0, laneCount: () => 1, MAX_LANES: 4 };
});
const modules = import.meta.glob(["./**/*.ts", "./**/*.js", "!./**/*.test.ts"]);

describe("AP2 mandates over MCP", () => {
  it("says there is no mandate yet on a simulated wallet, and a settled simulated payment carries none", async () => {
    const t = convexTest(schema, modules);
    const o = t.withIdentity({ subject: "alice", issuer: "https://test.local", tokenIdentifier: "https://test.local|alice" });
    await o.mutation(api.users.ensure, {});
    const claude = await o.mutation(api.onboarding.addAssistant, { provider: "claude" });
    await o.mutation(api.gateway.issueToken, { agentId: claude });
    const m = await t.query(internal.gateway.mandate, { agentId: claude });
    expect(m).toMatchObject({ mandate: null });
    expect(String((m as { reason: string }).reason)).toMatch(/vault/);
  });

  it("is refused for a frozen assistant", async () => {
    const t = convexTest(schema, modules);
    const o = t.withIdentity({ subject: "bob", issuer: "https://test.local", tokenIdentifier: "https://test.local|bob" });
    await o.mutation(api.users.ensure, {});
    const claude = await o.mutation(api.onboarding.addAssistant, { provider: "claude" });
    await o.mutation(api.gateway.issueToken, { agentId: claude });
    await t.run((ctx) => ctx.db.patch(claude, { status: "frozen" }));
    await expect(t.query(internal.gateway.mandate, { agentId: claude })).rejects.toThrow(/frozen/);
  });
});
