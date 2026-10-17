/**
 * A family guardian stops a held payment on Base Sepolia. The owner (a sandbox with a live vault)
 * invites a guardian (a second sandbox); Claude pays $6 over MCP, the vault holds it; the guardian
 * sees it and stops it; the vault's own event says it was cancelled and never left.
 *
 *   E2E_CONVEX_URL=… E2E_DEMO_JWK=… GUARDIAN=1 pnpm --filter @agent-wallet/domain exec vitest run guardian.e2e
 *
 * Fresh demo sandboxes, never the judge account.
 */
import { parseEventLogs, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { policyVaultAbi } from "./abi";
import { CONVEX, enabled, harness, mcp, pub, until } from "./e2e-harness";
import { EXPLORER } from "./vault";

const run = enabled && process.env.GUARDIAN ? describe : describe.skip;
const owner = harness("guardian-owner");
const guardian = harness("guardian-family");

run(`family guardian stops a held payment (${CONVEX})`, () => {
  it("guardian sees the held payment and stops it; the vault cancels it", async () => {
    const { vault } = await owner.liveVault();
    await guardian.convex("mutation", "users:ensure");
    const code = await owner.convex<string>("mutation", "guardians:invite", { name: "Priya (daughter)" });
    await guardian.convex("mutation", "guardians:accept", { code });
    const me = await owner.convex<{ _id: string } | null>("query", "users:me");
    const ownerId = (me as { _id: string })._id;

    const agents = await owner.convex<{ _id: string; provider: string; status: string }[]>("query", "agents:list");
    const claude = agents.find((a) => a.provider === "claude")!;
    if (claude.status === "frozen") {
      const t = await owner.convex<string | null>("mutation", "agents:setStatus", { agentId: claude._id, status: "active" });
      if (t) await owner.approve(t, ["queued", "confirmed", "failed"]);
    }
    const key = await owner.convex<string>("mutation", "gateway:issueToken", { agentId: claude._id });
    const shop = (await mcp<{ contactId: string; name: string }[]>(key, "list_contacts")).value.find((c) => c.name === "Blue Tokai")!.contactId;
    const from = await pub.getBlockNumber();
    const pay = (await mcp<{ outcome: string; taskId: string }>(key, "propose_payment", { contactId: shop, amount: 6, reason: "prize fee", requestId: `guardian-${Date.now()}` })).value;
    expect(pay.outcome).toBe("submitted");

    type Watch = { held: { taskId: string; amount: string; payee: string }[] } | null;
    const seen = await until("the guardian sees it held", async () => (await guardian.convex<Watch>("query", "guardians:watch", { ownerId }))?.held.find((h) => h.taskId === pay.taskId), 180_000);
    expect(seen).toMatchObject({ amount: "$6.00", payee: "Blue Tokai" });
    await guardian.convex("mutation", "guardians:cancelHeld", { taskId: pay.taskId });

    const cancelled = await until(
      "the vault's cancel",
      async () => {
        const head = await pub.getBlockNumber();
        for (let b = from; b <= head; b += 199n) {
          const logs = await pub.getLogs({ address: vault as Address, fromBlock: b, toBlock: b + 198n > head ? head : b + 198n });
          const e = parseEventLogs({ abi: policyVaultAbi, logs }).find((x) => x.eventName === "PaymentCancelled");
          if (e) return e;
        }
        return null;
      },
      180_000,
    );
    owner.log("Claude's $6 held", (await mcp<{ transaction: string | null }>(key, "get_task_status", { taskId: pay.taskId })).value.transaction?.split("/tx/")[1]);
    owner.log("Guardian stopped it: PaymentCancelled", cancelled.transactionHash);
    console.log(`held then cancelled by the guardian: ${EXPLORER}/tx/${cancelled.transactionHash as Hex}`);
    // Nothing left on hold for it, and no release: the money never left the vault.
    const paymentId = (cancelled.args as { paymentId: Hex }).paymentId;
    const [, , , amount] = (await pub.readContract({ address: vault as Address, abi: policyVaultAbi, functionName: "held", args: [paymentId] })) as readonly unknown[];
    expect(amount).toBe(0n);
    const after = parseEventLogs({ abi: policyVaultAbi, logs: await pub.getLogs({ address: vault as Address, fromBlock: cancelled.blockNumber, toBlock: await pub.getBlockNumber() }) });
    expect(after.some((e) => e.eventName === "PaymentReleased" && (e.args as { paymentId: Hex }).paymentId === paymentId)).toBe(false);
  }, 900_000);
});
