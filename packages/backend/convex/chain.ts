import { v } from "convex/values";
import {
  BaseError,
  ContractFunctionRevertedError,
  concat,
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  keccak256,
  parseEther,
  parseEventLogs,
  sha256,
  toBytes,
  toHex,
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, contactIdOf, fromTokenUnits, isVaultVersion, keyIdOf, policyVaultAbi, testUsdAbi, toTokenUnits, vaultFactoryAbi } from "@agent-wallet/domain";
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { open, seal } from "./lib/secrets";
import { MAX_LANES, agentPool, laneCount, lanePool, relayer } from "./lib/relayer";

/**
 * Everything that sends transactions. The relayer pays gas and can submit what the owner signed,
 * deploy vaults, freeze, and cancel held payments or queued changes; the contract makes sure it
 * can't move money or loosen anything on its own. Each sending key has its own queue
 * (lib/relayer.ts): guardian-only actions on `relayer`, permissionless ones on the user's lane,
 * agent payments on `agentPool` with one send at a time per agent key.
 */

const chain = {
  id: CHAIN_ID,
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia.base.org"] } },
} as const;

/** A lane needs at least this to send; below it, work moves to lane 0 until the guardian tops it up. */
const LANE_FLOOR = parseEther("0.0001");
const LANE_TOPUP = parseEther("0.0003");
/** How long an agent key stays locked for one send, if the action dies before unlocking it. */
const AGENT_LOCK_MS = 150_000;

// Base Sepolia gas is about 0.006 gwei: an agent payment costs roughly 0.000001 ETH, but the wallet
// must hold gas limit × max fee up front (about 0.000004 for a held payment), so keep a margin.
const AGENT_GAS = parseEther("0.00002");
const AGENT_GAS_FLOOR = parseEther("0.00001");
const RECEIPT_TIMEOUT = 60_000;
/** How long to wait for a receipt before calling the outcome unknown. Tests shorten it to force that path. */
const receiptTimeout = () => Number(process.env.CHAIN_RECEIPT_TIMEOUT_MS ?? RECEIPT_TIMEOUT);
const RECHECK_MS = 30_000;
const MAX_CHECKS = 20;

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function chainReady() {
  return Boolean(process.env.RELAYER_PRIVATE_KEY && process.env.FACTORY_ADDRESS && process.env.TOKEN_ADDRESS && process.env.AGENT_KEY_SECRET);
}

function clients(privateKey?: Hex) {
  const transport = http(process.env.CHAIN_RPC_URL ?? "https://sepolia.base.org", { timeout: 20_000, retryCount: 2 });
  const pub = createPublicClient({ chain, transport });
  const account = privateKeyToAccount((privateKey ?? env("RELAYER_PRIVATE_KEY")) as Hex);
  const wallet = createWalletClient({ chain, transport, account });
  return { pub, wallet, account };
}
type Pub = ReturnType<typeof clients>["pub"];

/**
 * Lane 0 is the guardian relayer. Other lanes' keys are derived from it and from this deployment's
 * URL, so dev and prod never share a nonce.
 */
function laneKey(lane: number): Hex {
  const root = env("RELAYER_PRIVATE_KEY") as Hex;
  if (lane === 0) return root;
  return keccak256(concat([root, toHex(`agent-wallet lane ${lane} ${process.env.CONVEX_CLOUD_URL ?? ""}`)]));
}

/**
 * Clients for a lane's key. If that lane is short of gas, the work goes back on lane 0 and this
 * returns null; the guardian's next runway check tops the lane up.
 */
async function laneClients(ctx: ActionCtx, lane: number, retry: (lane: number) => Promise<unknown>) {
  const c = clients(laneKey(lane));
  if (lane === 0) return c;
  const balance = await c.pub.getBalance({ address: c.account.address }).catch(() => 0n);
  if (balance >= LANE_FLOOR) return c;
  await retry(0);
  return null;
}
type KeyedAgent = { _id: Id<"agents">; chainAddress?: string };

/** sepolia.base.org is load-balanced, so a read right after a transaction can hit a node a block behind. */
async function settled<T>(read: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await read();
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/**
 * A node without the vault's code yet would "simulate" a call to it as a plain transfer and
 * estimate 21k-ish gas, so the real transaction runs out. Check the code is there first.
 */
async function ready(pub: Pub, vault: Address) {
  const code = await pub.getCode({ address: vault });
  if (!code || code === "0x") throw new Error("The vault isn't visible on this node yet");
}

function reason(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) return revert.data?.errorName ?? revert.shortMessage;
    return e.shortMessage;
  }
  return e instanceof Error ? e.message.slice(0, 160) : "Transaction failed";
}

/**
 * Send a contract call: simulate on a node that sees the vault, estimate with headroom, broadcast.
 * Throws before broadcast (nothing sent); returns the hash once broadcast.
 */
async function send(pub: Pub, wallet: ReturnType<typeof clients>["wallet"], call: Parameters<Pub["simulateContract"]>[0] & { address: Address }) {
  const gas = await settled(async () => {
    await ready(pub, call.address);
    await pub.simulateContract(call);
    return await pub.estimateContractGas(call as Parameters<Pub["estimateContractGas"]>[0]);
  });
  return await wallet.writeContract({ ...(call as Parameters<typeof wallet.writeContract>[0]), gas: (gas * 13n) / 10n });
}

/** After broadcast, a lost receipt is "unknown", never "failed": the transaction may still land. */
async function receipt(ctx: ActionCtx, pub: Pub, taskId: Id<"tasks">, hash: Hex, kind: "owner" | "agent" | "finalize" | "release", lane = 0) {
  try {
    return await pub.waitForTransactionReceipt({ hash, timeout: receiptTimeout() });
  } catch (e) {
    await ctx.runMutation(internal.vault.onUnknown, { taskId, txHash: hash, note: reason(e) });
    // A read, not a send: it needs no queue.
    await ctx.scheduler.runAfter(RECHECK_MS, internal.chain.reconcile, { taskId, kind, lane });
    return null;
  }
}

// ---------------------------------------------------------------- outcomes

async function ownerOutcome(ctx: ActionCtx, taskId: Id<"tasks">, r: TransactionReceipt, lane = 0) {
  if (r.status !== "success") {
    await ctx.runMutation(internal.vault.onOwnerResult, { taskId, txHash: r.transactionHash, ok: false, note: "Reverted" });
    return;
  }
  const queued = parseEventLogs({ abi: policyVaultAbi, logs: r.logs as Log[], eventName: "ChangeQueued" })[0];
  if (queued) {
    const readyAt = Number(queued.args.readyAt) * 1000;
    await ctx.runMutation(internal.vault.onQueued, { taskId, txHash: r.transactionHash, changeId: queued.args.changeId, readyAt });
    await lanePool(lane).enqueueAction(ctx, internal.chain.finalizeChange, { taskId, lane }, { runAt: readyAt + 5_000 });
    return;
  }
  await ctx.runMutation(internal.vault.onOwnerResult, { taskId, txHash: r.transactionHash, ok: true });
}

async function agentOutcome(ctx: ActionCtx, taskId: Id<"tasks">, r: TransactionReceipt, walletId: Id<"wallets">, lane = 0) {
  const logs = r.logs as Log[];
  const executed = parseEventLogs({ abi: policyVaultAbi, logs, eventName: "PaymentExecuted" });
  const held = parseEventLogs({ abi: policyVaultAbi, logs, eventName: "PaymentHeld" })[0];
  const refused = parseEventLogs({ abi: policyVaultAbi, logs, eventName: "PaymentRefused" })[0];
  const selfFrozen = parseEventLogs({ abi: policyVaultAbi, logs, eventName: "Frozen" }).find((f) => f.args.by.toLowerCase() === f.address.toLowerCase());
  if (held) {
    const releaseAt = Number(held.args.releaseAt) * 1000;
    await ctx.runMutation(internal.vault.onHeld, { taskId, txHash: r.transactionHash, releaseAt });
    await lanePool(lane).enqueueAction(ctx, internal.chain.releaseHeld, { taskId, lane }, { runAt: releaseAt + 5_000 });
  } else {
    await ctx.runMutation(internal.vault.onAgentResult, {
      taskId,
      txHash: r.transactionHash,
      ok: r.status === "success" && executed.length > 0,
      code: refused ? Number(refused.args.code) : undefined,
      note: r.status === "success" ? undefined : "Reverted",
    });
  }
  if (selfFrozen) await ctx.runMutation(internal.vault.onStruckOut, { walletId, agentAddress: selfFrozen.args.agent });
}

/**
 * A release that went through either paid the contact or, on v3, cancelled the hold because its
 * agent was removed or expired, its contact changed, or it was settled more than a day late.
 */
async function releaseOutcome(ctx: ActionCtx, taskId: Id<"tasks">, r: TransactionReceipt) {
  const released = parseEventLogs({ abi: policyVaultAbi, logs: r.logs as Log[], eventName: "PaymentReleased" }).length > 0;
  const cancelled = parseEventLogs({ abi: policyVaultAbi, logs: r.logs as Log[], eventName: "PaymentCancelled" }).length > 0;
  await ctx.runMutation(internal.vault.onAgentResult, {
    taskId,
    txHash: r.transactionHash,
    ok: r.status === "success" && released,
    note: r.status !== "success" ? "Reverted" : cancelled ? "Not sent: the agent or contact changed while it was held" : released ? undefined : "Not sent",
  });
}

// ---------------------------------------------------------------- deploy

export const deployVault = internalAction({
  args: { walletId: v.id("wallets"), lane: v.optional(v.number()) },
  handler: async (ctx, { walletId, lane = 0 }) => {
    const w = await ctx.runQuery(internal.vault.walletForChain, { walletId });
    if (!w || !w.keyX || !w.keyY || !w.rpId) return;
    try {
      const c = await laneClients(ctx, lane, (l) => lanePool(l).enqueueAction(ctx, internal.chain.deployVault, { walletId, lane: l }));
      if (!c) return;
      const { pub, wallet } = c;
      const token = env("TOKEN_ADDRESS") as Address;
      const factory = env("FACTORY_ADDRESS") as Address;
      const rpIdHash = sha256(toBytes(w.rpId));
      const salt = sha256(toBytes(`vault:v2:${walletId}:${w.keyX}`));
      const args = [token, w.keyX as Hex, w.keyY as Hex, rpIdHash, toTokenUnits(w.protectedMinor), toTokenUnits(w.dailyCeilingMinor), BigInt(24 * 3600), salt] as const;
      const vault = await pub.readContract({ address: factory, abi: vaultFactoryAbi, functionName: "predict", args });
      const code = await pub.getCode({ address: vault });
      let deployTx: Hex | undefined;
      if (!code || code === "0x") {
        deployTx = await wallet.writeContract({ address: factory, abi: vaultFactoryAbi, functionName: "createVault", args });
        const r = await pub.waitForTransactionReceipt({ hash: deployTx, timeout: RECEIPT_TIMEOUT });
        if (r.status !== "success") throw new Error("Vault deployment reverted");
      }
      // v2 vaults have no VERSION(); the encodings we send depend on which one this is.
      const version = await pub
        .readContract({ address: vault, abi: policyVaultAbi, functionName: "VERSION" })
        .then(Number)
        .catch(() => 2);
      // Test dollars so the demo has something to spend. Anyone can mint these; they're worthless.
      const fund = await wallet.writeContract({ address: token, abi: testUsdAbi, functionName: "faucet", args: [vault, toTokenUnits(10_000)] });
      await pub.waitForTransactionReceipt({ hash: fund, timeout: RECEIPT_TIMEOUT });

      // One signing key per agent that may spend, sealed before it leaves this action.
      // It gets gas on its first payment, never money.
      const keys: { agentId: Id<"agents">; address: string; privateKey: string }[] = [];
      for (const agentId of w.spendingAgents) {
        const privateKey = generatePrivateKey();
        keys.push({ agentId, address: privateKeyToAccount(privateKey).address, privateKey: await seal(privateKey, agentId) });
      }
      await ctx.runMutation(internal.vault.onDeployed, {
        walletId,
        address: vault,
        keyId: keyIdOf(w.keyX as Hex, w.keyY as Hex),
        version,
        tokenAddress: token,
        deployTx: deployTx ?? fund,
        agentKeys: keys,
      });
      await readVaultTwice(ctx, pub, walletId);
    } catch (e) {
      await ctx.runMutation(internal.vault.onError, { walletId, note: reason(e) });
    }
  },
});

// ---------------------------------------------------------------- owner

const auth = v.object({
  r: v.string(),
  s: v.string(),
  challengeIndex: v.number(),
  typeIndex: v.number(),
  authenticatorData: v.string(),
  clientDataJSON: v.string(),
});

/** Submit an action the owner signed with their passkey. */
export const relayOwner = internalAction({
  args: { taskId: v.id("tasks"), auth, keyId: v.string(), lane: v.optional(v.number()) },
  handler: async (ctx, { taskId, auth: a, keyId, lane = 0 }) => {
    const t = await ctx.runQuery(internal.vault.taskForChain, { taskId });
    if (!t?.action || !t.vault) return;
    const c = await laneClients(ctx, lane, (l) => lanePool(l).enqueueAction(ctx, internal.chain.relayOwner, { taskId, auth: a, keyId, lane: l }));
    if (!c) return;
    const { pub, wallet, account } = c;
    let hash: Hex;
    try {
      hash = await send(pub, wallet, {
        address: t.vault as Address,
        abi: policyVaultAbi,
        functionName: "execute",
        args: [
          { op: t.action.op, data: t.action.data as Hex, nonce: BigInt(t.action.nonce), deadline: BigInt(t.action.deadline) },
          keyId as Hex,
          {
            r: a.r as Hex,
            s: a.s as Hex,
            challengeIndex: BigInt(a.challengeIndex),
            typeIndex: BigInt(a.typeIndex),
            authenticatorData: a.authenticatorData as Hex,
            clientDataJSON: a.clientDataJSON,
          },
        ],
        account,
      });
    } catch (e) {
      // Nothing was broadcast, so nothing changed.
      await ctx.runMutation(internal.vault.onOwnerResult, { taskId, ok: false, note: reason(e) });
      return;
    }
    await ctx.runMutation(internal.vault.onSubmitted, { taskId, txHash: hash });
    const r = await receipt(ctx, pub, taskId, hash, "owner", lane);
    if (!r) return;
    await ownerOutcome(ctx, taskId, r, lane);
    await readVaultTwice(ctx, pub, t.walletId);
  },
});

/** Apply a queued owner change once its delay has passed. */
export const finalizeChange = internalAction({
  args: { taskId: v.id("tasks"), lane: v.optional(v.number()) },
  handler: async (ctx, { taskId, lane = 0 }) => {
    const t = await ctx.runQuery(internal.vault.taskForChain, { taskId });
    if (!t?.action || !t.vault || t.state !== "queued") return;
    const c = await laneClients(ctx, lane, (l) => lanePool(l).enqueueAction(ctx, internal.chain.finalizeChange, { taskId, lane: l }));
    if (!c) return;
    const { pub, wallet, account } = c;
    let hash: Hex;
    try {
      hash = await send(pub, wallet, {
        address: t.vault as Address,
        abi: policyVaultAbi,
        functionName: "finalize",
        args: [t.action.op, t.action.data as Hex, BigInt(t.action.nonce)],
        account,
      });
    } catch (e) {
      const why = reason(e);
      if (why === "NotReady") await lanePool(lane).enqueueAction(ctx, internal.chain.finalizeChange, { taskId, lane }, { runAt: Date.now() + RECHECK_MS });
      else await ctx.runMutation(internal.vault.onOwnerResult, { taskId, ok: false, note: why === "NotQueued" ? "Cancelled before it applied" : why });
      return;
    }
    await ctx.runMutation(internal.vault.onSubmitted, { taskId, txHash: hash, keepState: true });
    const r = await receipt(ctx, pub, taskId, hash, "finalize", lane);
    if (!r) return;
    await ctx.runMutation(internal.vault.onOwnerResult, { taskId, txHash: hash, ok: r.status === "success", note: r.status === "success" ? undefined : "Reverted" });
    await readVaultTwice(ctx, pub, t.walletId);
  },
});

// ---------------------------------------------------------------- agents

/** An agent pays inside its limits with its own key. The contract decides; refusals are recorded on-chain. */
export const agentPay = internalAction({
  args: { taskId: v.id("tasks"), lane: v.optional(v.number()), funded: v.optional(v.boolean()) },
  handler: async (ctx, { taskId, lane = 0, funded }) => {
    const t = await ctx.runQuery(internal.vault.agentTaskForChain, { taskId });
    if (!t) return;
    // One send at a time per agent key; others wait their turn without holding up other agents.
    if (!(await ctx.runMutation(internal.vault.lockAgentKey, { agentId: t.agentId, until: Date.now() + AGENT_LOCK_MS }))) {
      await agentPool.enqueueAction(ctx, internal.chain.agentPay, { taskId, lane, funded }, { runAt: Date.now() + 2_000 });
      return;
    }
    try {
      const { pub } = clients();
      let hash: Hex;
      try {
        if (!funded && (await pub.getBalance({ address: t.agentAddress as Address })) < AGENT_GAS_FLOOR) {
          // Gas comes from a relayer key, so its own queue sends it and then hands the payment back.
          await lanePool(lane).enqueueAction(ctx, internal.chain.fundAgent, { taskId, lane });
          return;
        }
        const { wallet, account } = clients((await open(t.agentKey, t.agentId)) as Hex);
        hash = await send(pub, wallet, {
          address: t.vault as Address,
          abi: policyVaultAbi,
          functionName: "agentPay",
          // The purpose is hashed with the task id, so a guessable purpose can't be read off the chain.
          args: [contactIdOf(t.payeeId), toTokenUnits(t.amountMinor), t.paymentId as Hex, sha256(toBytes(`${taskId}:${t.purpose ?? ""}`))],
          account,
        });
      } catch (e) {
        await ctx.runMutation(internal.vault.onAgentResult, { taskId, ok: false, note: reason(e) });
        return;
      }
      await ctx.runMutation(internal.vault.onSubmitted, { taskId, txHash: hash });
      const r = await receipt(ctx, pub, taskId, hash, "agent", lane);
      if (!r) return;
      await agentOutcome(ctx, taskId, r, t.walletId, lane);
      await readVaultTwice(ctx, pub, t.walletId);
    } finally {
      await ctx.runMutation(internal.vault.unlockAgentKey, { agentId: t.agentId });
    }
  },
});

/** Give an agent key gas for its payment from this lane's relayer key, then send the payment. */
export const fundAgent = internalAction({
  args: { taskId: v.id("tasks"), lane: v.number() },
  handler: async (ctx, { taskId, lane }) => {
    const t = await ctx.runQuery(internal.vault.agentTaskForChain, { taskId });
    if (!t) return;
    const c = await laneClients(ctx, lane, (l) => lanePool(l).enqueueAction(ctx, internal.chain.fundAgent, { taskId, lane: l }));
    if (!c) return;
    try {
      if ((await c.pub.getBalance({ address: t.agentAddress as Address })) < AGENT_GAS_FLOOR) {
        const top = await c.wallet.sendTransaction({ to: t.agentAddress as Address, value: AGENT_GAS });
        await c.pub.waitForTransactionReceipt({ hash: top, timeout: RECEIPT_TIMEOUT });
      }
    } catch (e) {
      await ctx.runMutation(internal.vault.onAgentResult, { taskId, ok: false, note: reason(e) });
      return;
    }
    // A load-balanced node may not show the new balance yet; the payment knows it was funded.
    await agentPool.enqueueAction(ctx, internal.chain.agentPay, { taskId, lane, funded: true });
  },
});

/** Send a held agent payment once its window has passed. */
export const releaseHeld = internalAction({
  args: { taskId: v.id("tasks"), lane: v.optional(v.number()) },
  handler: async (ctx, { taskId, lane = 0 }) => {
    const t = await ctx.runQuery(internal.vault.heldForChain, { taskId });
    if (!t || t.state !== "held") return;
    const c = await laneClients(ctx, lane, (l) => lanePool(l).enqueueAction(ctx, internal.chain.releaseHeld, { taskId, lane: l }));
    if (!c) return;
    const { pub, wallet, account } = c;
    let hash: Hex;
    try {
      hash = await send(pub, wallet, { address: t.vault as Address, abi: policyVaultAbi, functionName: "release", args: [t.paymentId as Hex], account });
    } catch (e) {
      const why = reason(e);
      if (why === "NotReady") {
        await lanePool(lane).enqueueAction(ctx, internal.chain.releaseHeld, { taskId, lane }, { runAt: Date.now() + RECHECK_MS });
      } else if (why === "AgentFrozen" || why === "BadAction" || why === "BreachesProtected") {
        // Frozen since, the contact changed, or it would now dip into the protected amount: don't
        // send. Cancel so the money is free again.
        const note = { AgentFrozen: "Not sent: frozen while it was held", BadAction: "Not sent: the contact changed", BreachesProtected: "Not sent: it would dip into the protected amount" }[why];
        await ctx.runMutation(internal.vault.onAgentResult, { taskId, ok: false, note });
        await relayer.enqueueAction(ctx, internal.chain.cancelHeld, { taskId, quiet: true });
      } else {
        await ctx.runMutation(internal.vault.onAgentResult, { taskId, ok: false, note: why === "NotQueued" ? "Cancelled" : why });
      }
      return;
    }
    await ctx.runMutation(internal.vault.onSubmitted, { taskId, txHash: hash, keepState: true });
    const r = await receipt(ctx, pub, taskId, hash, "release", lane);
    if (!r) return;
    await releaseOutcome(ctx, taskId, r);
    await readVaultTwice(ctx, pub, t.walletId);
  },
});

/** Guardian cancel of a held payment. Tightening, so no passkey is needed. */
export const cancelHeld = internalAction({
  args: { taskId: v.id("tasks"), quiet: v.optional(v.boolean()) },
  handler: async (ctx, { taskId, quiet }) => {
    const t = await ctx.runQuery(internal.vault.heldForChain, { taskId });
    if (!t) return;
    const { pub, wallet, account } = clients();
    try {
      const hash = await send(pub, wallet, { address: t.vault as Address, abi: policyVaultAbi, functionName: "cancelHeld", args: [t.paymentId as Hex], account });
      const r = await pub.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT });
      if (r.status !== "success") throw new Error("Reverted");
      if (!quiet) await ctx.runMutation(internal.vault.onCancelled, { taskId, txHash: hash });
    } catch (e) {
      if (!quiet) await ctx.runMutation(internal.vault.onCancelFailed, { taskId, note: reason(e) });
    }
    await readVaultTwice(ctx, pub, t.walletId);
  },
});

/** Guardian cancel of a queued loosening. */
export const cancelChange = internalAction({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const t = await ctx.runQuery(internal.vault.taskForChain, { taskId });
    if (!t?.vault || !t.changeId) return;
    const { pub, wallet, account } = clients();
    try {
      const hash = await send(pub, wallet, { address: t.vault as Address, abi: policyVaultAbi, functionName: "cancelChange", args: [t.changeId as Hex], account });
      const r = await pub.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT });
      if (r.status !== "success") throw new Error("Reverted");
      await ctx.runMutation(internal.vault.onCancelled, { taskId, txHash: hash });
    } catch (e) {
      await ctx.runMutation(internal.vault.onCancelFailed, { taskId, note: reason(e) });
    }
  },
});

/** Tightening needs no passkey: the guardian freezes the vault or one agent, then reads it back. */
export const guardianFreeze = internalAction({
  args: { walletId: v.id("wallets"), agentId: v.optional(v.id("agents")) },
  handler: async (ctx, { walletId, agentId }) => {
    const w = await ctx.runQuery(internal.vault.walletForChain, { walletId });
    if (!w?.address) return;
    const agent = agentId ? w.agents.find((a: KeyedAgent) => a._id === agentId) : null;
    if (agentId && !agent?.chainAddress) return;
    const { pub, wallet, account } = clients();
    try {
      const hash = agent
        ? await send(pub, wallet, { address: w.address as Address, abi: policyVaultAbi, functionName: "freezeAgent", args: [agent.chainAddress as Address], account })
        : await send(pub, wallet, { address: w.address as Address, abi: policyVaultAbi, functionName: "freeze", account });
      const r = await pub.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT });
      if (r.status !== "success") throw new Error("Freeze reverted");
      // Only a read-back of the vault counts as frozen.
      const frozen = await settled(async () => {
        const value = agent
          ? ((await pub.readContract({ address: w.address as Address, abi: policyVaultAbi, functionName: "agents", args: [agent.chainAddress as Address] }))[4] as boolean)
          : await pub.readContract({ address: w.address as Address, abi: policyVaultAbi, functionName: "frozen" });
        if (!value) throw new Error("Not frozen yet");
        return value;
      });
      await ctx.runMutation(internal.vault.onFreezeResult, { walletId, agentId, ok: frozen, txHash: hash });
    } catch (e) {
      await ctx.runMutation(internal.vault.onFreezeResult, { walletId, agentId, ok: false, note: reason(e) });
    }
    await readVaultTwice(ctx, pub, walletId);
  },
});

/** Look again for a transaction whose receipt we lost, and settle the task from what the chain says. */
export const reconcile = internalAction({
  args: { taskId: v.id("tasks"), kind: v.union(v.literal("owner"), v.literal("agent"), v.literal("finalize"), v.literal("release")), lane: v.optional(v.number()) },
  handler: async (ctx, { taskId, kind, lane = 0 }) => {
    const t = await ctx.runQuery(internal.vault.taskForChain, { taskId });
    if (!t?.txHash || t.state !== "unknown") return;
    const { pub } = clients();
    const r = await pub.getTransactionReceipt({ hash: t.txHash as Hex }).catch(() => null);
    if (!r) {
      const checks = await ctx.runMutation(internal.vault.onChecked, { taskId });
      if (checks < MAX_CHECKS) await ctx.scheduler.runAfter(RECHECK_MS, internal.chain.reconcile, { taskId, kind, lane });
      return;
    }
    if (kind === "owner") await ownerOutcome(ctx, taskId, r, lane);
    else if (kind === "agent") await agentOutcome(ctx, taskId, r, t.walletId, lane);
    else if (kind === "finalize") await ctx.runMutation(internal.vault.onOwnerResult, { taskId, txHash: r.transactionHash, ok: r.status === "success", note: r.status === "success" ? undefined : "Reverted" });
    else await releaseOutcome(ctx, taskId, r);
    await readVaultTwice(ctx, pub, t.walletId);
  },
});

// ---------------------------------------------------------------- runway

/** Gas one sandbox uses from the relayer: vault deploy (about 5M), faucet, setup approval, margin. */
const SANDBOX_GAS = 7_000_000n;
/** Agent keys a sandbox usually funds on their first payment. */
const SANDBOX_AGENTS = 2n;

/** Read the relayer's test ETH and estimate how many more sandboxes it covers. */
export const checkRunway = internalAction({
  args: {},
  handler: async (ctx) => {
    if (!chainReady()) return;
    const { pub, account } = clients();
    const lanes = Array.from({ length: laneCount() }, (_, i) => privateKeyToAccount(laneKey(i)).address);
    const [balances, gasPrice] = await Promise.all([Promise.all(lanes.map((address) => pub.getBalance({ address }))), pub.getGasPrice()]);
    const perSandbox = gasPrice * SANDBOX_GAS + AGENT_GAS * SANDBOX_AGENTS;
    const total = balances.reduce((s, b) => s + b, 0n);
    await ctx.runMutation(internal.ops.record, {
      address: account.address,
      balancesWei: balances.map(String),
      perSandboxWei: perSandbox.toString(),
      runway: Number(total / perSandbox),
    });
    // Extra lanes are topped up from the guardian, through its own queue.
    for (let lane = 1; lane < lanes.length; lane++) {
      if (balances[lane]! < LANE_FLOOR * 2n && balances[0]! > LANE_TOPUP * 2n) await relayer.enqueueAction(ctx, internal.chain.fundLane, { lane });
    }
  },
});

/** Send a lane key its gas from the guardian relayer. Runs on the guardian's queue. */
export const fundLane = internalAction({
  args: { lane: v.number() },
  handler: async (_ctx, { lane }) => {
    if (lane < 1 || lane >= MAX_LANES) return;
    const { pub, wallet } = clients();
    const to = privateKeyToAccount(laneKey(lane)).address;
    if ((await pub.getBalance({ address: to })) >= LANE_FLOOR * 2n) return;
    const hash = await wallet.sendTransaction({ to, value: LANE_TOPUP });
    await pub.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT });
  },
});

// ---------------------------------------------------------------- reads

/** Read what the vault enforces right now and store it, so screens show the chain, not our wishes. */
async function readVault(ctx: ActionCtx, pub: Pub, walletId: Id<"wallets">) {
  const w = await ctx.runQuery(internal.vault.walletForChain, { walletId });
  if (!w?.address || !w.tokenAddress || !isVaultVersion(w.version)) return;
  const vault = { address: w.address as Address, abi: policyVaultAbi } as const;
  try {
    const [balance, frozen, protectedAmount, ceiling, contactDelay, changeDelay, holdAbove, holdFor, held, spent, headroom, ownerKeys] = await settled(() =>
      Promise.all([
        pub.readContract({ address: w.tokenAddress as Address, abi: testUsdAbi, functionName: "balanceOf", args: [w.address as Address] }),
        pub.readContract({ ...vault, functionName: "frozen" }),
        pub.readContract({ ...vault, functionName: "protectedAmount" }),
        pub.readContract({ ...vault, functionName: "dailyCeiling" }),
        pub.readContract({ ...vault, functionName: "newContactDelay" }),
        pub.readContract({ ...vault, functionName: "changeDelay" }),
        pub.readContract({ ...vault, functionName: "holdAbove" }),
        pub.readContract({ ...vault, functionName: "holdFor" }),
        pub.readContract({ ...vault, functionName: "heldTotal" }),
        pub.readContract({ ...vault, functionName: "vaultSpentToday" }),
        pub.readContract({ ...vault, functionName: "agentHeadroom" }),
        pub.readContract({ ...vault, functionName: "ownerKeyCount" }),
      ]),
    );
    const agents = await Promise.all(
      w.agents
        .filter((a: KeyedAgent) => a.chainAddress)
        .map(async (a: KeyedAgent) => {
          const [s, agentSpent] = await settled(() =>
            Promise.all([
              pub.readContract({ ...vault, functionName: "agents", args: [a.chainAddress as Address] }),
              pub.readContract({ ...vault, functionName: "spentToday", args: [a.chainAddress as Address] }),
            ]),
          );
          return {
            agentId: a._id,
            perPaymentMinor: fromTokenUnits(s[0]),
            dailyCapMinor: fromTokenUnits(s[1]),
            expiresAt: Number(s[2]) * 1000,
            active: s[3],
            frozen: s[4],
            strikes: Number(s[5]),
            spentMinor: fromTokenUnits(agentSpent),
          };
        }),
    );
    await ctx.runMutation(internal.vault.onVaultState, {
      walletId,
      vault: {
        version: w.version!,
        protectedMinor: fromTokenUnits(protectedAmount),
        ceilingMinor: fromTokenUnits(ceiling),
        contactDelay: Number(contactDelay),
        changeDelay: Number(changeDelay),
        holdAboveMinor: fromTokenUnits(holdAbove),
        holdFor: Number(holdFor),
        frozen,
        balanceMinor: fromTokenUnits(balance),
        heldMinor: fromTokenUnits(held),
        spentMinor: fromTokenUnits(spent),
        headroomMinor: fromTokenUnits(headroom),
        ownerKeys: Number(ownerKeys),
        syncedAt: Date.now(),
      },
      agents,
    });
  } catch (e) {
    // A failed read leaves the last known state; the follow-up read below or the next refresh tries again.
    console.error("readVault failed", reason(e));
  }
}

/** Read now, and again shortly: the node that answered first may not have seen the last block yet. */
async function readVaultTwice(ctx: ActionCtx, pub: Pub, walletId: Id<"wallets">) {
  await readVault(ctx, pub, walletId);
  await ctx.scheduler.runAfter(6_000, internal.chain.syncVault, { walletId });
}

export const syncVault = internalAction({
  args: { walletId: v.id("wallets") },
  handler: async (ctx, { walletId }) => {
    await readVault(ctx, clients().pub, walletId);
  },
});

/** For the README and status screen: how much gas the relayer has left. */
export const relayerStatus = internalAction({
  args: {},
  handler: async () => {
    const { pub, account } = clients();
    return { address: account.address, eth: formatEther(await pub.getBalance({ address: account.address })) };
  },
});

/** Give an agent that newly may spend its own key, then ask the owner to register it. */
export const provisionAgent = internalAction({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    const privateKey = generatePrivateKey();
    const address = privateKeyToAccount(privateKey).address;
    await ctx.runMutation(internal.vault.onAgentKey, { agentId, address, privateKey: await seal(privateKey, agentId) });
  },
});
