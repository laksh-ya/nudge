/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

// Any MCP assistant, not only the listed vendors: each one its own record, key and limits.
vi.mock("./lib/relayer", () => {
  const pool = { enqueueAction: vi.fn(async () => "queued") };
  return { relayer: pool, agentPool: pool, lanePool: () => pool, laneOf: () => 0, laneCount: () => 1, MAX_LANES: 4 };
});
const modules = import.meta.glob(["./**/*.ts", "./**/*.js", "!./**/*.test.ts"]);

async function owner() {
  const t = convexTest(schema, modules);
  const o = t.withIdentity({ subject: "alice", issuer: "https://test.local", tokenIdentifier: "https://test.local|alice" });
  await o.mutation(api.users.ensure, {});
  return { t, o };
}

describe("connecting any assistant", () => {
  it("adds any named MCP assistant, as many as the owner wants, each with its own key", async () => {
    const { t, o } = await owner();
    const codex = await o.mutation(api.onboarding.addAssistant, { provider: "other", name: "Codex" });
    const instinct = await o.mutation(api.onboarding.addAssistant, { provider: "other", name: "Instinct" });
    expect(codex).not.toBe(instinct);
    const rows = await t.run((ctx) => Promise.all([ctx.db.get(codex), ctx.db.get(instinct)]));
    expect(rows.map((r) => [r!.name, r!.provider, r!.status, r!.scopes])).toEqual([
      ["Codex", "other", "pending", ["read", "prepare", "request"]],
      ["Instinct", "other", "pending", ["read", "prepare", "request"]],
    ]);
    const k1 = await o.mutation(api.gateway.issueToken, { agentId: codex });
    const k2 = await o.mutation(api.gateway.issueToken, { agentId: instinct });
    expect(k1).not.toBe(k2);
  });

  it("adding the same name again returns the same assistant", async () => {
    const { o } = await owner();
    const a = await o.mutation(api.onboarding.addAssistant, { provider: "other", name: "Gemini CLI" });
    expect(await o.mutation(api.onboarding.addAssistant, { provider: "other", name: "  gemini   cli " })).toBe(a);
  });

  it("needs a plain name for an other assistant", async () => {
    const { o } = await owner();
    for (const name of [undefined, "", "   ", "<script>", "pay $9 now!"]) {
      await expect(o.mutation(api.onboarding.addAssistant, { provider: "other", name })).rejects.toThrow(/Name the assistant/);
    }
  });

  it("caps how many assistants one owner connects", async () => {
    const { o } = await owner();
    // A fresh account already has its seeded assistants; fill the rest of the 12.
    let added = 0;
    for (let i = 0; i < 20; i++) {
      try {
        await o.mutation(api.onboarding.addAssistant, { provider: "other", name: `Agent ${i}` });
        added++;
      } catch (e) {
        expect(String(e)).toMatch(/Up to 12 assistants/);
        break;
      }
    }
    expect(added).toBeGreaterThan(0);
    expect(added).toBeLessThan(20);
  });
});
