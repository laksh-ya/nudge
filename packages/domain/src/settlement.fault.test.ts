/**
 * Settlement under a lost broadcast, on a local Anvil with the real backend in-process (the eval's
 * simulator) and a real v3 vault. Finding on #57: a held payment whose release transaction never
 * reached the node, and whose relayer nonce another transaction then used, is marked failed while
 * the money is still held in the vault, and nothing releases or returns it.
 *
 *   anvil --chain-id 84532 --port 8546
 *   (cd contracts && forge build)
 *   FAULT=1 pnpm --filter @agent-wallet/domain exec vitest run settlement.fault
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, type Server } from "node:http";
import { parseEventLogs, type Address, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { policyVaultAbi } from "./abi";
import { mutex, type Sim } from "./eval/sim";
import { RELAYER_KEY, chain, clients, deployContracts, internalRef, makeWorld } from "./eval/world";

const als = new AsyncLocalStorage<{ sim: Sim }>();
(globalThis as Record<string, unknown>).__evalAls = als;

vi.mock("../../backend/convex/lib/relayer", () => {
  const pool = {
    enqueueAction: async (_ctx: unknown, fn: unknown, args: Record<string, unknown>, opts?: { runAt?: number }) => {
      const conv = ((globalThis as Record<string, unknown>).__evalAls as AsyncLocalStorage<{ sim: Sim }>).getStore();
      if (!conv?.sim) throw new Error("relayer used outside a test world");
      return conv.sim.enqueue(fn, args, opts?.runAt ?? Date.now());
    },
  };
  return { relayer: pool, agentPool: pool, lanePool: () => pool, laneOf: () => 0, laneCount: () => 1, MAX_LANES: 1 };
});

vi.mock("viem", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, any>;
  const fast = (create: (o: any) => unknown) => (o: Record<string, unknown>) => create({ pollingInterval: 50, cacheTime: 0, ...o });
  return { ...real, createPublicClient: fast(real.createPublicClient), createWalletClient: fast(real.createWalletClient), createTestClient: fast(real.createTestClient) };
});

/** An RPC proxy that, while armed, swallows eth_sendRawTransaction: the node never sees it. */
function lossyRpc(upstream: string) {
  let armed = false;
  const dropped: string[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString();
    const call = JSON.parse(body) as { id: number; method: string; params: unknown[] };
    res.setHeader("content-type", "application/json");
    if (armed && call.method === "eth_sendRawTransaction") {
      dropped.push(String(call.params[0]));
      res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32000, message: "FAULT: connection reset" } }));
      return;
    }
    const up = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body });
    res.end(await up.text());
  });
  return {
    server,
    dropped,
    arm: (on: boolean) => void (armed = on),
    url: async () => {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    },
  };
}

const run = process.env.FAULT ? describe : describe.skip;
const serial = mutex();

run("settlement under a lost broadcast (#52, #57)", () => {
  let contracts: { token: Address; factory: Address };
  let seal: (plain: string, context: string) => Promise<string>;
  const proxy = lossyRpc(chain.rpcUrls.default.http[0]);

  beforeAll(async () => {
    expect(await clients().pub.getChainId()).toBe(chain.id);
    process.env.RELAYER_PRIVATE_KEY = RELAYER_KEY;
    process.env.CHAIN_RPC_URL = await proxy.url();
    process.env.AGENT_KEY_SECRET ??= Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    delete process.env.TELEGRAM_BOT_TOKEN;
    contracts = await deployContracts();
    ({ seal } = await import("../../backend/convex/lib/secrets"));
  }, 120_000);

  afterAll(() => proxy.server.close());

  it("a replaced release leaves the held payment released, returned, or still held: never 'failed' with the money stuck", async () => {
    const world = await makeWorld(contracts, serial, seal);
    const { pub, relayer, test } = clients();
    const warp = async (atMs: number) => {
      const now = Number((await pub.getBlock()).timestamp);
      const target = Math.ceil(atMs / 1000);
      if (target > now) {
        await test.increaseTime({ seconds: target - now + 1 });
        await test.mine({ blocks: 1 });
      }
    };

    await als.run({ sim: world.sim }, async () => {
      // $8 to a saved contact: within Claude's limits, above the $5 hold, so the vault holds it.
      const out = await world.sim.run(internalRef("gateway:proposePayment"), { agentId: world.mcpAgentId, contactId: "payees_4", amount: 8, reason: "coffee beans" });
      expect(out.outcome).toBe("submitted");
      await world.sim.drain({ serial, only: (j) => j.name !== "chain:releaseHeld" });
      const task = world.sim.tables.tasks!.find((t) => t._id === out.taskId)!;
      expect(task.state).toBe("held");

      // The release is signed and recorded, but its broadcast never reaches the node.
      proxy.arm(true);
      await world.sim.drain({ serial, max: 1, only: (j) => j.name === "chain:releaseHeld", beforeJob: (j) => serial(() => warp(j.at)) });
      proxy.arm(false);
      expect(proxy.dropped).toHaveLength(1);
      expect(task.state).toBe("unknown");

      // The relayer's next transaction (any other user's job on the same lane) takes that nonce.
      await serial(async () => pub.waitForTransactionReceipt({ hash: await relayer.sendTransaction({ to: relayer.account.address, value: 0n }) }));

      // Reconciliation: re-sends the same bytes (refused: nonce used), then after three looks decides.
      await world.sim.drain({ serial, max: 20 });

      const [, , , amount] = (await pub.readContract({ address: world.vault, abi: policyVaultAbi, functionName: "held", args: [task.paymentId as Hex] })) as readonly unknown[];
      const stillHeld = (amount as bigint) > 0n;
      const pending = world.sim.jobs.filter((j) => (j.name === "chain:releaseHeld" || j.name === "chain:cancelHeld") && j.args.taskId === task._id);
      const report = { state: task.state, reason: task.reason, stillHeldOnChain: stillHeld, heldUnits: String(amount), pendingJobs: pending.map((j) => j.name) };
      console.log("replaced release:", JSON.stringify(report));
      expect(stillHeld && task.state === "failed" && pending.length === 0, `task says failed while ${String(amount)} units stay held and nothing will move them: ${JSON.stringify(report)}`).toBe(false);
      // Fixed (#57): the task went back to held and a fresh release ran, so the contact was paid once.
      expect(report.state, JSON.stringify(report)).toBe("confirmed");
      expect(stillHeld).toBe(false);
      const events = parseEventLogs({ abi: policyVaultAbi, logs: await pub.getLogs({ address: world.vault, fromBlock: world.startBlock }) });
      expect(events.filter((e) => e.eventName === "PaymentReleased")).toHaveLength(1);
    });
  }, 300_000);
});
