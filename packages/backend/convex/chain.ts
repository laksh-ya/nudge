import { v } from "convex/values";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  parseEventLogs,
  sha256,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  CHAIN_ID,
  contactIdOf,
  fromTokenUnits,
  keyIdOf,
  paymentIdOf,
  policyVaultAbi,
  testUsdAbi,
  toTokenUnits,
  vaultFactoryAbi,
} from "@agent-wallet/domain";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * Everything that sends transactions. The relayer pays gas and can submit what the owner signed,
 * deploy vaults and freeze; the contract makes sure it can't move money on its own.
 */

const chain = {
  id: CHAIN_ID,
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia.base.org"] } },
} as const;

// Base Sepolia gas is about 0.006 gwei, so an agent payment costs roughly 0.000001 ETH.
const AGENT_GAS = parseEther("0.000005");
const AGENT_GAS_FLOOR = parseEther("0.000002");

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function chainReady() {
  return Boolean(process.env.RELAYER_PRIVATE_KEY && process.env.FACTORY_ADDRESS && process.env.TOKEN_ADDRESS);
}

function clients(privateKey?: Hex) {
  const transport = http(process.env.CHAIN_RPC_URL ?? "https://sepolia.base.org", { timeout: 20_000, retryCount: 2 });
  const pub = createPublicClient({ chain, transport });
  const account = privateKeyToAccount((privateKey ?? env("RELAYER_PRIVATE_KEY")) as Hex);
  const wallet = createWalletClient({ chain, transport, account });
  return { pub, wallet, account };
}

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
async function ready(pub: ReturnType<typeof clients>["pub"], vault: Address) {
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

export const deployVault = internalAction({
  args: { walletId: v.id("wallets") },
  handler: async (ctx, { walletId }) => {
    const w = await ctx.runQuery(internal.vault.walletForChain, { walletId });
    if (!w || !w.keyX || !w.keyY || !w.rpId) return;
    try {
      const { pub, wallet } = clients();
      const token = env("TOKEN_ADDRESS") as Address;
      const factory = env("FACTORY_ADDRESS") as Address;
      const rpIdHash = sha256(toBytes(w.rpId));
      const salt = sha256(toBytes(`vault:${walletId}:${w.keyX}`));
      const args = [
        token,
        w.keyX as Hex,
        w.keyY as Hex,
        rpIdHash,
        toTokenUnits(w.protectedMinor),
        toTokenUnits(w.dailyCeilingMinor),
        BigInt(24 * 3600),
        salt,
      ] as const;
      const vault = await pub.readContract({ address: factory, abi: vaultFactoryAbi, functionName: "predict", args });
      const code = await pub.getCode({ address: vault });
      let deployTx: Hex | undefined;
      if (!code || code === "0x") {
        deployTx = await wallet.writeContract({ address: factory, abi: vaultFactoryAbi, functionName: "createVault", args });
        const r = await pub.waitForTransactionReceipt({ hash: deployTx });
        if (r.status !== "success") throw new Error("Vault deployment reverted");
      }
      // Test dollars so the demo has something to spend. Anyone can mint these; they're worthless.
      const fund = await wallet.writeContract({ address: token, abi: testUsdAbi, functionName: "faucet", args: [vault, toTokenUnits(10_000)] });
      await pub.waitForTransactionReceipt({ hash: fund });
      const keyId = keyIdOf(w.keyX as Hex, w.keyY as Hex);

      // One signing key per agent that may spend. It gets gas on its first payment, never money.
      const keys: { agentId: Id<"agents">; address: string; privateKey: string }[] = [];
      for (const agentId of w.spendingAgents) {
        const privateKey = generatePrivateKey();
        keys.push({ agentId, address: privateKeyToAccount(privateKey).address, privateKey });
      }
      await ctx.runMutation(internal.vault.onDeployed, {
        walletId,
        address: vault,
        keyId,
        tokenAddress: token,
        deployTx: deployTx ?? fund,
        agentKeys: keys,
      });
      await ctx.scheduler.runAfter(4000, internal.chain.syncBalance, { walletId });
    } catch (e) {
      await ctx.runMutation(internal.vault.onError, { walletId, note: reason(e) });
    }
  },
});

/** Submit an action the owner signed with their passkey. */
export const relayOwner = internalAction({
  args: {
    taskId: v.id("tasks"),
    auth: v.object({
      r: v.string(),
      s: v.string(),
      challengeIndex: v.number(),
      typeIndex: v.number(),
      authenticatorData: v.string(),
      clientDataJSON: v.string(),
    }),
  },
  handler: async (ctx, { taskId, auth }) => {
    const t = await ctx.runQuery(internal.vault.taskForChain, { taskId });
    if (!t?.action || !t.vault || !t.keyId) return;
    try {
      const { pub, wallet, account } = clients();
      const call = {
        address: t.vault as Address,
        abi: policyVaultAbi,
        functionName: "execute",
        args: [
          { op: t.action.op, data: t.action.data as Hex, nonce: BigInt(t.action.nonce), deadline: BigInt(t.action.deadline) },
          t.keyId as Hex,
          {
            r: auth.r as Hex,
            s: auth.s as Hex,
            challengeIndex: BigInt(auth.challengeIndex),
            typeIndex: BigInt(auth.typeIndex),
            authenticatorData: auth.authenticatorData as Hex,
            clientDataJSON: auth.clientDataJSON,
          },
        ],
        account,
      } as const;
      // Simulate first so a bad signature costs nothing and gives a clear reason.
      const gas = await settled(async () => {
        await ready(pub, call.address);
        await pub.simulateContract(call);
        return await pub.estimateContractGas(call);
      });
      const hash = await wallet.writeContract({ ...call, gas: (gas * 13n) / 10n });
      await ctx.runMutation(internal.vault.onSubmitted, { taskId, txHash: hash });
      const r = await pub.waitForTransactionReceipt({ hash });
      await ctx.runMutation(internal.vault.onOwnerResult, { taskId, txHash: hash, ok: r.status === "success", note: r.status === "success" ? undefined : "Reverted" });
      await ctx.scheduler.runAfter(4000, internal.chain.syncBalance, { walletId: t.walletId });
    } catch (e) {
      await ctx.runMutation(internal.vault.onOwnerResult, { taskId, ok: false, note: reason(e) });
    }
  },
});

/** An agent pays inside its limits with its own key. The contract decides; refusals are recorded on-chain. */
export const agentPay = internalAction({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const t = await ctx.runQuery(internal.vault.agentTaskForChain, { taskId });
    if (!t) return;
    try {
      const { pub, wallet: relayer } = clients();
      const balance = await pub.getBalance({ address: t.agentAddress as Address });
      if (balance < AGENT_GAS_FLOOR) {
        const top = await relayer.sendTransaction({ to: t.agentAddress as Address, value: AGENT_GAS });
        await pub.waitForTransactionReceipt({ hash: top });
      }
      const { wallet, account } = clients(t.agentKey as Hex);
      const call = {
        address: t.vault as Address,
        abi: policyVaultAbi,
        functionName: "agentPay",
        args: [contactIdOf(t.payeeId), toTokenUnits(t.amountMinor), paymentIdOf(taskId), sha256(toBytes(t.purpose ?? ""))],
        account,
      } as const;
      const gas = await settled(async () => {
        await ready(pub, call.address);
        await pub.simulateContract(call);
        return await pub.estimateContractGas(call);
      });
      const hash = await wallet.writeContract({ ...call, gas: (gas * 13n) / 10n });
      await ctx.runMutation(internal.vault.onSubmitted, { taskId, txHash: hash });
      const r = await pub.waitForTransactionReceipt({ hash });
      const executed = parseEventLogs({ abi: policyVaultAbi, logs: r.logs, eventName: "PaymentExecuted" });
      const refused = parseEventLogs({ abi: policyVaultAbi, logs: r.logs, eventName: "PaymentRefused" });
      await ctx.runMutation(internal.vault.onAgentResult, {
        taskId,
        txHash: hash,
        ok: r.status === "success" && executed.length > 0,
        code: refused[0] ? Number(refused[0].args.code) : undefined,
        note: r.status === "success" ? undefined : "Reverted",
      });
      await ctx.scheduler.runAfter(4000, internal.chain.syncBalance, { walletId: t.walletId });
    } catch (e) {
      await ctx.runMutation(internal.vault.onAgentResult, { taskId, ok: false, note: reason(e) });
    }
  },
});

/** Tightening needs no passkey: the guardian freezes the vault or one agent. */
export const guardianFreeze = internalAction({
  args: { walletId: v.id("wallets"), agentAddress: v.optional(v.string()) },
  handler: async (ctx, { walletId, agentAddress }) => {
    const w = await ctx.runQuery(internal.vault.walletForChain, { walletId });
    if (!w?.address) return;
    try {
      const { pub, wallet } = clients();
      const hash = agentAddress
        ? await wallet.writeContract({ address: w.address as Address, abi: policyVaultAbi, functionName: "freezeAgent", args: [agentAddress as Address] })
        : await wallet.writeContract({ address: w.address as Address, abi: policyVaultAbi, functionName: "freeze" });
      await pub.waitForTransactionReceipt({ hash });
      await ctx.runMutation(internal.vault.onFrozen, { walletId, txHash: hash, agent: agentAddress });
    } catch (e) {
      await ctx.runMutation(internal.vault.onError, { walletId, note: `Freeze failed: ${reason(e)}`, keepLive: true });
    }
  },
});

export const syncBalance = internalAction({
  args: { walletId: v.id("wallets") },
  handler: async (ctx, { walletId }) => {
    const w = await ctx.runQuery(internal.vault.walletForChain, { walletId });
    if (!w?.address || !w.tokenAddress) return;
    const { pub } = clients();
    const [balance, frozen] = await settled(() =>
      Promise.all([
        pub.readContract({ address: w.tokenAddress as Address, abi: testUsdAbi, functionName: "balanceOf", args: [w.address as Address] }),
        pub.readContract({ address: w.address as Address, abi: policyVaultAbi, functionName: "frozen" }),
      ]),
    );
    await ctx.runMutation(internal.vault.onBalance, { walletId, balanceMinor: fromTokenUnits(balance), frozen });
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
    await ctx.runMutation(internal.vault.onAgentKey, { agentId, address, privateKey });
  },
});
