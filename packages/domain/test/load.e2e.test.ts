/**
 * Load check for the demo (issue #8): N visitors at once each open a sandbox, create a passkey,
 * get a vault deployed and approve its setup. Every one must finish, and within two minutes.
 *
 * Costs the relayer test ETH (about 0.00004 per sandbox at 0.006 gwei), so it runs only when asked:
 *   E2E_LOAD=10 E2E_CONVEX_URL=… E2E_DEMO_JWK=… npx vitest run load.e2e
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { enabled, harness } from "./e2e-harness";

const N = Number(process.env.E2E_LOAD ?? 0);
const run = enabled && N > 0 ? describe : describe.skip;
const LIMIT_MS = 120_000;

run(`Base Sepolia: ${N} sandboxes at once`, () => {
  it(`deploys and approves ${N} vaults concurrently in under two minutes`, async () => {
    const batch = randomBytes(4).toString("hex");
    const start = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: N }, async (_, i) => {
        const h = harness(`load-${batch}-${i}`);
        const v = await h.liveVault();
        return { i, ms: Date.now() - start, vault: v.vault, deployTx: v.deployTx, setupTx: v.setupTx };
      }),
    );
    const elapsed = Date.now() - start;
    const done = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`#${i}: ${String(r.reason).slice(0, 200)}`] : []));
    const report = { batch, sandboxes: N, completed: done.length, elapsedMs: elapsed, slowestMs: Math.max(0, ...done.map((d) => d.ms)), results: done, failed };
    const file = join(tmpdir(), `agent-wallet-load-${batch}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`${done.length}/${N} sandboxes live and approved in ${(elapsed / 1000).toFixed(1)} s (report: ${file})`);
    for (const f of failed) console.log(f);
    expect(failed).toEqual([]);
    expect(elapsed).toBeLessThan(LIMIT_MS);
  }, 600_000);
});
