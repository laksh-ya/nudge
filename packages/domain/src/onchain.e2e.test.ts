/**
 * The whole product path on Base Sepolia, through the real backend: passkey enrolment, vault deployment,
 * the one-approval setup, an agent paying over MCP, an over-limit payment approved by passkey, a freeze and
 * a passkey unfreeze, and a stolen agent key calling the vault directly and being refused on-chain.
 *
 * A software P-256 key stands in for the phone and builds the same assertion a browser would.
 * It resets the shared demo account on the target deployment and spends a little relayer gas. The test passkey is
 * kept in the temp folder so a rerun reuses the live vault instead of deploying another.
 *
 *   E2E_CONVEX_URL=https://<dev>.convex.cloud pnpm --filter @agent-wallet/domain exec vitest run onchain.e2e
 *
 * Transaction links are written to $TMPDIR/agent-wallet-e2e-hashes.json.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha2";
import { createPublicClient, createWalletClient, http, parseEventLogs, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { policyVaultAbi } from "./abi";
import { CHAIN_ID, EXPLORER, actionDigest, contactIdOf, paymentIdOf, toTokenUnits, type Op } from "./vault";
import { base64url, toWebAuthnAuth } from "./webauthn";

const CONVEX = process.env.E2E_CONVEX_URL;
const SITE = CONVEX?.replace(".convex.cloud", ".convex.site");
const RP_ID = "agent-wallet-approve.vercel.app";
const run = CONVEX ? describe : describe.skip;

const chain = {
  id: CHAIN_ID,
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia.base.org"] } },
} as const;
const pub = createPublicClient({ chain, transport: http() });

const hashes: Record<string, string> = {};
const log = (label: string, hash?: string | null) => {
  if (!hash) return;
  hashes[label] = hash;
  console.log(`${label.padEnd(34)} ${EXPLORER}/tx/${hash}`);
};

async function convex<T>(kind: "query" | "mutation", path: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${CONVEX}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const body = (await res.json()) as { status: string; value?: T; errorMessage?: string };
  if (body.status !== "success") throw new Error(`${path}: ${body.errorMessage}`);
  return body.value as T;
}

async function until<T>(what: string, read: () => Promise<T | null | undefined | false>, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** What `navigator.credentials.get` returns on a phone, signed by a software key. */
function assertion(priv: Uint8Array, challenge: Hex) {
  const authenticatorData = new Uint8Array([...sha256(new TextEncoder().encode(RP_ID)), 0x05, 0, 0, 0, 1]);
  const clientDataJSON = new TextEncoder().encode(
    JSON.stringify({ type: "webauthn.get", challenge: base64url(Buffer.from(challenge.slice(2), "hex")), origin: `https://${RP_ID}`, crossOrigin: false }),
  );
  const msg = sha256(new Uint8Array([...authenticatorData, ...sha256(clientDataJSON)]));
  const sig = p256.sign(msg, priv, { prehash: false, lowS: false });
  return toWebAuthnAuth({ authenticatorData, clientDataJSON, signature: sig.toDERRawBytes() });
}

type Approval = {
  state: string;
  txHash: string | null;
  reason?: string;
  onchain: { action: { op: Op; data: Hex; nonce: string | number; deadline: number }; vault: Address } | null;
};

/** The approval page's job: compute the digest from the shown action, sign it, hand it to the relayer. */
async function approve(priv: Uint8Array, token: string) {
  const page = await convex<Approval>("query", "approvals:get", { token });
  expect(page.onchain).not.toBeNull();
  const { action, vault } = page.onchain!;
  const digest = actionDigest({ op: action.op, data: action.data, nonce: BigInt(action.nonce), deadline: BigInt(action.deadline) }, vault);
  const auth = assertion(priv, digest);
  await convex("mutation", "approvals:submit", {
    token,
    auth: { ...auth, challengeIndex: Number(auth.challengeIndex), typeIndex: Number(auth.typeIndex) },
  });
  const done = await until("the relayer", async () => {
    const t = await convex<Approval>("query", "approvals:get", { token });
    return t.state === "confirmed" || t.state === "failed" ? t : null;
  });
  expect(done.reason ?? "").not.toMatch(/Not sent/);
  expect(done.state).toBe("confirmed");
  return done.txHash!;
}

async function mcp<T>(key: string, name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${SITE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await res.json()) as { result?: { structuredContent: T; isError: boolean }; error?: { message: string } };
  return { status: res.status, value: body.result?.structuredContent as T, error: body.error?.message };
}

run("Base Sepolia, end to end", () => {
  const keyFile = join(tmpdir(), `agent-wallet-e2e-${new URL(CONVEX ?? "http://x").hostname}.json`);
  const saved = existsSync(keyFile) ? (JSON.parse(readFileSync(keyFile, "utf8")) as { priv: string; vault: Address }) : null;
  const priv = saved ? Uint8Array.from(Buffer.from(saved.priv, "hex")) : p256.utils.randomPrivateKey();
  const point = p256.getPublicKey(priv, false);
  const x = `0x${Buffer.from(point.slice(1, 33)).toString("hex")}`;
  const y = `0x${Buffer.from(point.slice(33)).toString("hex")}`;
  let vault: Address;
  let claudeId: string;
  let claudeKey: string;
  let shopId: string;

  it("creates a passkey, deploys the vault and registers agents and contacts with one approval", async () => {
    type Status = { wallet: { status: string; statusNote?: string; address: Address; deployTx: string } | null; setup: { token: string } | null };
    const before = await convex<Status>("query", "vault:status");
    const reuse = saved && before.wallet?.status === "live" && before.wallet.address === saved.vault;
    if (!reuse) {
      await convex("mutation", "demo:restore");
      const enrol = await convex<string>("mutation", "vault:startEnrol");
      await convex("mutation", "vault:completeEnrol", { token: enrol, credentialId: base64url(crypto.getRandomValues(new Uint8Array(32))), x, y, rpId: RP_ID });
    }
    const live = await until("the vault", async () => {
      const s = await convex<Status>("query", "vault:status");
      if (s.wallet?.status === "error") throw new Error(s.wallet.statusNote);
      return s.wallet?.status === "live" ? s : null;
    }, 180_000);
    vault = live.wallet!.address;
    writeFileSync(keyFile, JSON.stringify({ priv: Buffer.from(priv).toString("hex"), vault }));
    log("Vault deployed", live.wallet!.deployTx);
    if (live.setup) log("Setup: agents + contacts", await approve(priv, live.setup.token));
    expect(await pub.readContract({ address: vault, abi: policyVaultAbi, functionName: "frozen" })).toBe(false);
  }, 300_000);

  it("lets Claude pay a contact inside its limits, with its own key", async () => {
    const agents = await convex<{ _id: string; provider: string }[]>("query", "agents:list");
    claudeId = agents.find((a) => a.provider === "claude")!._id;
    claudeKey = await convex<string>("mutation", "gateway:issueToken", { agentId: claudeId });
    const contacts = (await mcp<{ contactId: string; name: string }[]>(claudeKey, "list_contacts")).value;
    shopId = contacts.find((c) => c.name === "Blue Tokai")!.contactId;
    const paid = (await mcp<{ outcome: string; taskId: string }>(claudeKey, "propose_payment", { contactId: shopId, amount: 8, reason: "Coffee beans" })).value;
    expect(paid.outcome).toBe("paid");
    const status = await until("the agent payment", async () => {
      const s = (await mcp<{ state: string; transaction: string | null; reason: string | null }>(claudeKey, "get_task_status", { taskId: paid.taskId })).value;
      return s.state === "confirmed" || s.state === "failed" ? s : null;
    });
    expect(status.reason).toBeNull();
    expect(status.state).toBe("confirmed");
    log("Claude pays $8 (within limits)", status.transaction?.split("/tx/")[1]);
  }, 180_000);

  it("turns an over-limit payment into a passkey approval", async () => {
    const asked = (await mcp<{ outcome: string; approvalUrl: string }>(claudeKey, "propose_payment", { contactId: shopId, amount: 18, reason: "A bigger order" })).value;
    expect(asked.outcome).toBe("needs_approval");
    log("Owner approves $18 by passkey", await approve(priv, asked.approvalUrl.split("/a/")[1]!));
  }, 180_000);

  it("refuses a stolen agent key that skips our server, and records why on-chain", async () => {
    const tasks = execFileSync("npx", ["convex", "data", "tasks", "--format", "jsonLines", "--limit", "50"], { cwd: "../backend", encoding: "utf8" });
    const agentTask = tasks
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { _id: string; agentId?: string; rail?: string; state: string })
      .find((t) => t.agentId === claudeId && t.rail === "base-sepolia" && t.state === "confirmed")!;
    const leaked = JSON.parse(
      execFileSync("npx", ["convex", "run", "vault:agentTaskForChain", JSON.stringify({ taskId: agentTask._id })], { cwd: "../backend", encoding: "utf8" }),
    ) as { agentKey: Hex; payeeId: string };
    const thief = createWalletClient({ chain, transport: http(), account: privateKeyToAccount(leaked.agentKey) });
    const attempt = async (label: string, contact: string, cents: number, id: Hex) => {
      const hash = await thief.writeContract({
        address: vault,
        abi: policyVaultAbi,
        functionName: "agentPay",
        args: [contactIdOf(contact), toTokenUnits(cents), id, `0x${"00".repeat(32)}`],
      });
      const r = await pub.waitForTransactionReceipt({ hash });
      log(label, hash);
      return parseEventLogs({ abi: policyVaultAbi, logs: r.logs, eventName: "PaymentRefused" }).map((e) => Number(e.args.code));
    };
    expect(await attempt("Stolen key: $50 → refused 2003", leaked.payeeId, 5_000, paymentIdOf("thief-1"))).toEqual([2003]);
    expect(await attempt("Stolen key: replay → refused 2007", leaked.payeeId, 800, paymentIdOf(agentTask._id))).toEqual([2007]);
    expect(await attempt("Stolen key: own address → refused 2010", "attacker", 100, paymentIdOf("thief-2"))).toEqual([2010]);
  }, 180_000);

  it("freezes Claude in the vault without a passkey, and unfreezes only with one", async () => {
    await convex("mutation", "agents:setStatus", { agentId: claudeId, status: "frozen" });
    expect((await mcp(claudeKey, "list_contacts")).status).toBe(403);
    const agent = (await convex<{ _id: string; chainAddress: Address }[]>("query", "agents:list")).find((a) => a._id === claudeId)!;
    await until("the guardian freeze", async () => {
      // (perPayment, dailyCap, expiresAt, active, frozen)
      const fields = (await pub.readContract({ address: vault, abi: policyVaultAbi, functionName: "agents", args: [agent.chainAddress] })) as readonly unknown[];
      return fields[4] === true;
    });
    const token = await convex<string>("mutation", "agents:setStatus", { agentId: claudeId, status: "active" });
    log("Owner unfreezes Claude by passkey", await approve(priv, token));
    expect((await mcp(claudeKey, "list_contacts")).status).toBe(200);
    writeFileSync(join(tmpdir(), "agent-wallet-e2e-hashes.json"), JSON.stringify(hashes, null, 2));
  }, 180_000);
});
