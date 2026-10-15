/**
 * End-to-end check of the passkey path against the real contract on a local chain.
 * Run with: anvil --chain-id 84532 --port 8546, deploy, then ANVIL_URL=... TOKEN=... FACTORY=... vitest run
 */
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha2";
import { createPublicClient, createWalletClient, http, parseEventLogs, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { policyVaultAbi, testUsdAbi, vaultFactoryAbi } from "./abi";
import { CHAIN_ID, Op, actionDigest, contactIdOf, encode, paymentIdOf, toTokenUnits } from "./vault";
import { base64url, spkiToXY, toWebAuthnAuth } from "./webauthn";

const url = process.env.ANVIL_URL ?? "";
const run = url ? describe : describe.skip;
const RP_ID = "agent-wallet-approve.vercel.app";

function browserAssertion(priv: Uint8Array, challenge: Hex, flags = 0x05) {
  const authenticatorData = new Uint8Array([...sha256(new TextEncoder().encode(RP_ID)), flags, 0, 0, 0, 7]);
  const clientDataJSON = new TextEncoder().encode(
    JSON.stringify({ type: "webauthn.get", challenge: base64url(Buffer.from(challenge.slice(2), "hex")), origin: `https://${RP_ID}`, crossOrigin: false }),
  );
  const msg = sha256(new Uint8Array([...authenticatorData, ...sha256(clientDataJSON)]));
  // Browsers don't normalise s; force a high-s signature half the time to exercise our fix.
  const sig = p256.sign(msg, priv, { prehash: false, lowS: false });
  return { authenticatorData, clientDataJSON, signature: sig.toDERRawBytes() };
}

run("passkey approval on a local chain", () => {
  const chain = { id: CHAIN_ID, name: "local", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } } as const;
  const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
  const pub = createPublicClient({ chain, transport: http(url || "http://127.0.0.1:8546") });
  const wallet = createWalletClient({ chain, transport: http(url || "http://127.0.0.1:8546"), account });

  it("creates a vault for a passkey and pays with a browser-shaped assertion", async () => {
    const token = process.env.TOKEN as Address;
    const factory = process.env.FACTORY as Address;
    const priv = p256.utils.randomPrivateKey();
    const point = p256.getPublicKey(priv, false);
    const { x, y } = spkiToXY(new Uint8Array([...new Uint8Array(26), ...point]));
    const rpIdHash = `0x${Buffer.from(sha256(new TextEncoder().encode(RP_ID))).toString("hex")}` as Hex;
    const salt = `0x${Buffer.from(p256.utils.randomPrivateKey()).toString("hex")}` as Hex;
    const args = [token, x, y, rpIdHash, 0n, toTokenUnits(4_000), 0n, salt] as const;
    const vault = await pub.readContract({ address: factory, abi: vaultFactoryAbi, functionName: "predict", args });
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: factory, abi: vaultFactoryAbi, functionName: "createVault", args }) });
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: token, abi: testUsdAbi, functionName: "faucet", args: [vault, toTokenUnits(10_000)] }) });

    const to = privateKeyToAccount(generatePrivateKey()).address;
    for (let i = 0; i < 4; i++) {
      const action = { op: Op.Pay, data: encode.pay(to, toTokenUnits(150), `0x${(i + 1).toString(16).padStart(64, "0")}`), nonce: BigInt(1000 + i), deadline: BigInt(Math.floor(Date.now() / 1000) + 600) };
      const auth = toWebAuthnAuth(browserAssertion(priv, actionDigest(action, vault)));
      const keyId = await pub.readContract({ address: vault, abi: policyVaultAbi, functionName: "keyIdOf", args: [x, y] });
      const hash = await wallet.writeContract({ address: vault, abi: policyVaultAbi, functionName: "execute", args: [action, keyId, auth] });
      const receipt = await pub.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe("success");
      const paid = parseEventLogs({ abi: policyVaultAbi, logs: receipt.logs, eventName: "OwnerPaid" });
      expect(paid).toHaveLength(1);
    }
    const balance = await pub.readContract({ address: token, abi: testUsdAbi, functionName: "balanceOf", args: [to] });
    expect(balance).toBe(toTokenUnits(600));
  }, 60_000);

  it("registers an agent and a contact with one approval; the vault pays and refuses on its own", async () => {
    const token = process.env.TOKEN as Address;
    const factory = process.env.FACTORY as Address;
    const priv = p256.utils.randomPrivateKey();
    const { x, y } = spkiToXY(new Uint8Array([...new Uint8Array(26), ...p256.getPublicKey(priv, false)]));
    const rpIdHash = `0x${Buffer.from(sha256(new TextEncoder().encode(RP_ID))).toString("hex")}` as Hex;
    const args = [token, x, y, rpIdHash, toTokenUnits(5_000), toTokenUnits(2_000), 86400n, `0x${Buffer.from(p256.utils.randomPrivateKey()).toString("hex")}` as Hex] as const;
    const vault = await pub.readContract({ address: factory, abi: vaultFactoryAbi, functionName: "predict", args });
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: factory, abi: vaultFactoryAbi, functionName: "createVault", args }) });
    await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: token, abi: testUsdAbi, functionName: "faucet", args: [vault, toTokenUnits(10_000)] }) });
    const keyId = await pub.readContract({ address: vault, abi: policyVaultAbi, functionName: "keyIdOf", args: [x, y] });

    const agentKey = generatePrivateKey();
    const agent = privateKeyToAccount(agentKey);
    await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: agent.address, value: 10n ** 16n }) });
    const shop = privateKeyToAccount(generatePrivateKey()).address;
    const setup = {
      op: Op.Batch,
      data: encode.batch([
        { op: Op.SetAgent, data: encode.setAgent(agent.address, toTokenUnits(1_000), toTokenUnits(1_500), BigInt(Math.floor(Date.now() / 1000) + 86400 * 30)) },
        { op: Op.AddContact, data: encode.addContact(contactIdOf("payee-1"), shop, true) },
      ]),
      nonce: 7n,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    };
    const auth = toWebAuthnAuth(browserAssertion(priv, actionDigest(setup, vault)));
    const r1 = await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: vault, abi: policyVaultAbi, functionName: "execute", args: [setup, keyId, auth] }) });
    expect(r1.status).toBe("success");

    const agentWallet = createWalletClient({ chain, transport: http(url), account: agent });
    const pay = async (cents: number, task: string) => {
      const hash = await agentWallet.writeContract({ address: vault, abi: policyVaultAbi, functionName: "agentPay", args: [contactIdOf("payee-1"), toTokenUnits(cents), paymentIdOf(task), `0x${"00".repeat(32)}`] });
      const r = await pub.waitForTransactionReceipt({ hash });
      return {
        executed: parseEventLogs({ abi: policyVaultAbi, logs: r.logs, eventName: "PaymentExecuted" }).length,
        refused: parseEventLogs({ abi: policyVaultAbi, logs: r.logs, eventName: "PaymentRefused" }).map((l) => Number(l.args.code)),
      };
    };
    expect(await pay(800, "t1")).toEqual({ executed: 1, refused: [] });
    expect(await pay(1_800, "t2")).toEqual({ executed: 0, refused: [2003] });
    expect(await pay(800, "t1")).toEqual({ executed: 0, refused: [2007] });
    const balance = await pub.readContract({ address: token, abi: testUsdAbi, functionName: "balanceOf", args: [shop] });
    expect(balance).toBe(toTokenUnits(800));
  }, 60_000);
});
