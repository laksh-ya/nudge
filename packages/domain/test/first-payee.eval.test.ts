/**
 * The first payment to a brand-new payee, end to end on a real vault (#100): an assistant asks to pay
 * an address the vault has never seen, the approval page checks the bytes against the chain, the
 * owner's passkey signs once, the vault queues it for its change delay, it pays, and the payee is
 * still not trusted afterwards. This is the path the 18 Oct live coffee purchase took.
 *
 *   anvil --chain-id 84532 --port 8546
 *   (cd contracts && forge build)
 *   EVAL=1 pnpm --filter @agent-wallet/domain exec vitest run first-payee.eval
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { parseEventLogs, type Address, type Hex } from "viem";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { policyVaultAbi, testUsdAbi } from "../src/abi";
import { checkApproval, type ChainReader } from "../src/approval-truth";
import { CHAIN_ID, Op, actionDigest, toTokenUnits } from "../src/vault";
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

const run = process.env.EVAL ? describe : describe.skip;
const serial = mutex();
/** A bakery the vault has never heard of. */
const BAKERY = "0x2e6a1f0b8c9d3e4f5a6b7c8d9e0f1a2b3c4d5e6f" as Address;

run("first payment to a new payee on a real vault (#100)", () => {
  let contracts: { token: Address; factory: Address };
  let seal: (plain: string, context: string) => Promise<string>;

  beforeAll(async () => {
    expect(await clients().pub.getChainId()).toBe(chain.id);
    process.env.RELAYER_PRIVATE_KEY = RELAYER_KEY;
    process.env.CHAIN_RPC_URL = chain.rpcUrls.default.http[0];
    process.env.AGENT_KEY_SECRET ??= Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.TELEGRAM_BOT_TOKEN;
    contracts = await deployContracts();
    ({ seal } = await import("../../backend/convex/lib/secrets"));
  }, 120_000);

  it("one link, one passkey, paid after the change delay; the payee stays untrusted", async () => {
    const { pub, test } = clients();
    // Earlier evals fast-forward this local chain; run the backend's clock at the chain's time so the
    // deadlines it signs over are the ones the vault checks (on a real chain the two agree).
    const chainMs = Number((await pub.getBlock()).timestamp) * 1000;
    if (chainMs > Date.now()) vi.useFakeTimers({ toFake: ["Date"], now: chainMs, shouldAdvanceTime: true });
    const world = await makeWorld(contracts, serial, seal);
    const reader: ChainReader = {
      async contact(contactId) {
        const [payee, activeAt] = (await pub.readContract({ address: world.vault, abi: policyVaultAbi, functionName: "contacts", args: [contactId] })) as readonly [Address, bigint];
        return { payee, activeAt };
      },
    };
    // Move the chain to where a scheduled job is due (the vault's change delay), then run it.
    const warp = async (job: { name: string; at: number }) => {
      if (job.name !== "chain:finalizeChange" && job.name !== "chain:releaseHeld") return;
      await serial(async () => {
        const now = Number((await pub.getBlock()).timestamp);
        const target = Math.ceil(job.at / 1000);
        if (target > now) {
          await test.increaseTime({ seconds: target - now + 1 });
          await test.mine({ blocks: 1 });
        }
      });
    };

    await als.run({ sim: world.sim }, async () => {
      // 1. Claude asks to pay the bakery $3: a new payee, so the owner decides.
      const ask = await world.sim.run(internalRef("gateway:proposePayment"), { agentId: world.mcpAgentId, toAddress: BAKERY, name: "Corner Bakery", amount: 3, reason: "Bread", requestId: "bread-1" });
      expect(ask.outcome).toBe("needs_approval");
      const token = String(ask.approvalUrl).split("/a/")[1]!;
      // Asking again is the same request: the same link, not a second one.
      const again = await world.sim.run(internalRef("gateway:proposePayment"), { agentId: world.mcpAgentId, toAddress: BAKERY, name: "Corner Bakery", amount: 3, reason: "Bread", requestId: "bread-1" });
      expect(again.taskId).toBe(ask.taskId);

      // 2. The approval page reads the vault itself: a new payee, no disagreement, so it can be signed.
      const page = await world.sim.run(internalRef("approvals:get"), { token });
      const a = page.onchain.action as { op: number; data: Hex; nonce: string; deadline: number };
      const truth = await checkApproval(a.op as Op, a.data, { amountMinor: page.amountMinor, payee: page.payee, contacts: page.onchain.contacts, names: page.onchain.names }, reader);
      expect(truth.mismatches).toEqual([]);
      expect(truth.payee).toMatchObject({ fresh: true, saved: null });

      // 3. One passkey signature.
      const digest = actionDigest({ op: a.op as Op, data: a.data, nonce: BigInt(a.nonce), deadline: BigInt(a.deadline) }, world.vault, CHAIN_ID);
      const auth = world.ownerSign(digest);
      const signed = await world.sim.run(internalRef("approvals:submit"), { token, credentialId: "eval-credential", auth: { ...auth, challengeIndex: Number(auth.challengeIndex), typeIndex: Number(auth.typeIndex) } });
      expect(signed).toBe("reserved");

      // 4. The relayer sends it; the vault queues it (unknown address), then it pays after the delay.
      await world.sim.drain({ serial, beforeJob: warp });
      const task = await world.sim.run(internalRef("gateway:taskStatus"), { agentId: world.mcpAgentId, taskId: ask.taskId });
      expect(task).toMatchObject({ state: "confirmed", final: true });
    });

    // On-chain: the bakery got exactly $3 from the vault, through the owner's path.
    expect(await pub.readContract({ address: contracts.token, abi: testUsdAbi, functionName: "balanceOf", args: [BAKERY] })).toBe(toTokenUnits(300));
    const logs = await pub.getLogs({ address: world.vault, fromBlock: world.startBlock });
    const paid = parseEventLogs({ abi: policyVaultAbi, logs, eventName: "OwnerPaid" });
    expect(paid).toHaveLength(1);
    expect(parseEventLogs({ abi: policyVaultAbi, logs, eventName: "ChangeQueued" })).toHaveLength(1);

    // 5. Paying once didn't trust them: the next payment by Claude needs the owner again (#98).
    await als.run({ sim: world.sim }, async () => {
      const contacts = (await world.sim.run(internalRef("gateway:contacts"), { agentId: world.mcpAgentId })) as { name: string; status: string }[];
      expect(contacts.find((c) => c.name === "Corner Bakery")).toMatchObject({ status: "new" });
      const next = await world.sim.run(internalRef("gateway:proposePayment"), { agentId: world.mcpAgentId, toAddress: BAKERY, name: "Corner Bakery", amount: 2, reason: "More bread", requestId: "bread-2" });
      expect(next.outcome).toBe("needs_approval");
    });
    vi.useRealTimers();
  }, 300_000);
});
