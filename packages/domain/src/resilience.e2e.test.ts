/**
 * Two failure modes the review asked to prove on the real stack (Base Sepolia, dev backend):
 *
 * 1. Parallel requests near a limit: four $6 payments fired at once against Claude's $15 a day.
 *    At most two may be paid; the vault's own count must stay within $15.
 * 2. A lost receipt: the backend is told to give up waiting after 1 ms, so the payment it just sent
 *    is "unknown". A retry with the same requestId must not pay again, and the task must settle as
 *    paid once the transaction is found.
 *
 *   E2E_CONVEX_URL=… E2E_DEMO_JWK=… pnpm --filter @agent-wallet/domain exec vitest run resilience.e2e
 *
 * Briefly sets CHAIN_RECEIPT_TIMEOUT_MS on the dev deployment and removes it again.
 */
import { execFileSync } from "node:child_process";
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { policyVaultAbi } from "./abi";
import { enabled, harness, mcp, pub, taskState, until } from "./e2e-harness";

const run = enabled ? describe : describe.skip;
const backend = (args: string[]) => execFileSync("npx", ["convex", ...args], { cwd: "../backend", encoding: "utf8" });

run("Base Sepolia: races and lost receipts", () => {
  const h = harness("resilience");
  let vault: Address;
  let key: string;
  let shop: string;
  let claudeAddress: Address;

  it("sets up a vault and gives Claude a key", async () => {
    const v = await h.liveVault();
    vault = v.vault;
    h.log("Vault deployed", v.deployTx);
    h.log("Setup approved", v.setupTx);
    const agents = await h.convex<{ _id: string; provider: string; chainAddress?: Address }[]>("query", "agents:list");
    const claude = agents.find((a) => a.provider === "claude")!;
    claudeAddress = claude.chainAddress!;
    key = await h.convex<string>("mutation", "gateway:issueToken", { agentId: claude._id });
    shop = (await mcp<{ contactId: string; name: string }[]>(key, "list_contacts")).value.find((c) => c.name === "Blue Tokai")!.contactId;
  }, 400_000);

  it("never pays more than the limit when four requests race", async () => {
    const results = await Promise.all(
      [1, 2, 3, 4].map((i) => mcp<{ outcome: string; taskId: string }>(key, "propose_payment", { contactId: shop, amount: 6, reason: `Race ${i}`, requestId: `race-${i}` })),
    );
    const outcomes = results.map((r) => r.value.outcome);
    const paid = results.filter((r) => r.value.outcome === "submitted");
    expect(paid.length).toBe(2);
    expect(outcomes.filter((o) => o === "needs_approval").length).toBe(2);
    for (const p of paid) {
      const s = await taskState(key, p.value.taskId, ["held", "confirmed", "failed"]);
      expect(s.state).not.toBe("failed");
      h.log(`Race: paid ${p.value.taskId.slice(-6)}`, s.transaction?.split("/tx/")[1]);
    }
    const spent = await until("the vault's count", async () => {
      const n = await pub.readContract({ address: vault, abi: policyVaultAbi, functionName: "spentToday", args: [claudeAddress] });
      return n === 12_000_000n ? n : null;
    });
    expect(spent).toBe(12_000_000n);
  }, 300_000);

  it("keeps a payment with a lost receipt as unknown, never pays it twice, and settles it from the chain", async () => {
    backend(["env", "set", "CHAIN_RECEIPT_TIMEOUT_MS", "1"]);
    try {
      const first = (await mcp<{ outcome: string; taskId: string }>(key, "propose_payment", { contactId: shop, amount: 2, reason: "Lost receipt", requestId: "lost-1" })).value;
      expect(first.outcome).toBe("submitted");
      const unknown = await taskState(key, first.taskId, ["unknown", "confirmed", "failed"]);
      expect(unknown.state).toBe("unknown");
      const retry = (await mcp<{ outcome: string; taskId: string }>(key, "propose_payment", { contactId: shop, amount: 2, reason: "Lost receipt", requestId: "lost-1" })).value;
      expect(retry).toMatchObject({ outcome: "duplicate", taskId: first.taskId });
    } finally {
      backend(["env", "remove", "CHAIN_RECEIPT_TIMEOUT_MS"]);
    }
    const settled = await until(
      "reconciliation",
      async () => {
        const all = await h.convex<{ requestId?: string; state: string; txHash?: string }[]>("query", "tasks:list");
        const t = all.find((x) => x.requestId === "lost-1");
        return t && t.state !== "unknown" ? t : null;
      },
      180_000,
    );
    expect(settled.state).toBe("confirmed");
    h.log("Lost receipt reconciled: paid once", settled.txHash);
    const spent = await pub.readContract({ address: vault, abi: policyVaultAbi, functionName: "spentToday", args: [claudeAddress] });
    expect(spent).toBe(14_000_000n);
  }, 400_000);
});
