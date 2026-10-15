/**
 * The whole product path on Base Sepolia, through the real backend, in a fresh demo sandbox:
 * an owner-confirmed passkey, the vault and its rules, Claude paying over MCP (at once, held then
 * released, held then cancelled, and a retried request that never pays twice), an over-limit payment
 * the owner approves, a stolen agent key that strikes out and freezes itself, a delayed unfreeze,
 * a chat freeze checked with the old key, and a disconnect that removes the key from the vault.
 *
 * A software P-256 key stands in for the phone and builds what a browser would send.
 *
 *   E2E_CONVEX_URL=https://<dev>.convex.cloud E2E_DEMO_JWK=/path/to/demo-private.jwk.json \
 *     E2E_FUNDER_KEY=<relayer key> pnpm --filter @agent-wallet/domain exec vitest run onchain.e2e
 *
 * The dev deployment needs ALLOW_KEY_REVEAL=true so the test can play an attacker holding an agent key.
 *
 * Spends about 0.00004 ETH of relayer gas. Transaction links go to $TMPDIR/agent-wallet-e2e-hashes.json.
 */
import { execFileSync } from "node:child_process";
import { createPrivateKey, randomBytes, sign as nodeSign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha2";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { policyVaultAbi } from "./abi";
import { CHAIN_ID, EXPLORER, actionDigest, contactIdOf, paymentIdOf, toTokenUnits, type Op } from "./vault";
import { base64url, toWebAuthnAuth } from "./webauthn";

const CONVEX = process.env.E2E_CONVEX_URL;
const JWK = process.env.E2E_DEMO_JWK;
const SITE = CONVEX?.replace(".convex.cloud", ".convex.site");
const RP_ID = "agent-wallet-approve.vercel.app";
const run = CONVEX && JWK ? describe : describe.skip;

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
  hashes[label] = `${EXPLORER}/tx/${hash}`;
  writeFileSync(join(tmpdir(), "agent-wallet-e2e-hashes.json"), JSON.stringify(hashes, null, 2));
};

/** A demo-sandbox token, signed the way apps/web/app/api/demo/token does it. */
function demoToken(sub: string) {
  const jwk = JSON.parse(readFileSync(JWK!, "utf8")) as { kid?: string };
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = enc({ alg: "ES256", typ: "JWT", kid: jwk.kid ?? "demo-1" });
  const body = enc({ iss: "https://demo.agent-wallet.app", aud: "agent-wallet-demo", sub, iat: now, exp: now + 3600 });
  const sig = nodeSign("sha256", Buffer.from(`${head}.${body}`), { key: createPrivateKey({ key: jwk as never, format: "jwk" }), dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${sig.toString("base64url")}`;
}

// Saved between runs, so a rerun picks up the same sandbox and vault instead of paying for another.
const STATE = join(tmpdir(), "agent-wallet-e2e-v2.json");
const saved = existsSync(STATE) ? (JSON.parse(readFileSync(STATE, "utf8")) as { sub: string; priv: string; credentialId: string }) : null;
const SUB = saved?.sub ?? `e2e${randomBytes(15).toString("hex")}`;
let token = "";

async function convex<T>(kind: "query" | "mutation", path: string, args: Record<string, unknown> = {}, auth = true): Promise<T> {
  const res = await fetch(`${CONVEX}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const body = (await res.json()) as { status: string; value?: T; errorMessage?: string };
  if (body.status !== "success") throw new Error(`${path}: ${body.errorMessage}`);
  return body.value as T;
}

async function until<T>(what: string, read: () => Promise<T | null | undefined | false>, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const priv = saved ? Uint8Array.from(Buffer.from(saved.priv, "hex")) : p256.utils.randomPrivateKey();
const point = p256.getPublicKey(priv, false);
const x = `0x${Buffer.from(point.slice(1, 33)).toString("hex")}`;
const y = `0x${Buffer.from(point.slice(33)).toString("hex")}`;
const credentialId = saved?.credentialId ?? base64url(randomBytes(16));
writeFileSync(STATE, JSON.stringify({ sub: SUB, priv: Buffer.from(priv).toString("hex"), credentialId }));

/** What navigator.credentials.create returns for that key: our challenge, our site, the key in CBOR. */
function registration(challenge: string) {
  const cred = Buffer.from(credentialId, "base64url");
  const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), point.slice(1, 33), Buffer.from([0x22, 0x58, 0x20]), point.slice(33)]);
  const authData = Buffer.concat([sha256(new TextEncoder().encode(RP_ID)), Buffer.from([0x45, 0, 0, 0, 0]), Buffer.alloc(16), Buffer.from([0, cred.length]), cred, cose]);
  return {
    clientDataJSON: JSON.stringify({ type: "webauthn.create", challenge, origin: `https://${RP_ID}`, crossOrigin: false }),
    authenticatorData: `0x${authData.toString("hex")}`,
  };
}

/** What navigator.credentials.get returns on a phone, signed by the software key. */
function assertion(challenge: Hex) {
  const authenticatorData = new Uint8Array([...sha256(new TextEncoder().encode(RP_ID)), 0x05, 0, 0, 0, 1]);
  const clientDataJSON = new TextEncoder().encode(
    JSON.stringify({ type: "webauthn.get", challenge: base64url(Buffer.from(challenge.slice(2), "hex")), origin: `https://${RP_ID}`, crossOrigin: false }),
  );
  const msg = sha256(new Uint8Array([...authenticatorData, ...sha256(clientDataJSON)]));
  return toWebAuthnAuth({ authenticatorData, clientDataJSON, signature: p256.sign(msg, priv, { prehash: false, lowS: false }).toDERRawBytes() });
}

type Approval = {
  state: string;
  txHash: string | null;
  reason?: string;
  onchain: { action: { op: Op; data: Hex; nonce: string | number; deadline: number }; vault: Address } | null;
};

/** The approval page's job: compute the digest from the shown action, sign it, hand it to the relayer. */
async function approve(approvalToken: string, until_: string[] = ["confirmed", "failed"]) {
  const page = await convex<Approval>("query", "approvals:get", { token: approvalToken }, false);
  const { action, vault } = page.onchain!;
  const auth = assertion(actionDigest({ op: action.op, data: action.data, nonce: BigInt(action.nonce), deadline: BigInt(action.deadline) }, vault));
  await convex("mutation", "approvals:submit", { token: approvalToken, credentialId, auth: { ...auth, challengeIndex: Number(auth.challengeIndex), typeIndex: Number(auth.typeIndex) } }, false);
  const done = await until("the relayer", async () => {
    const t = await convex<Approval>("query", "approvals:get", { token: approvalToken }, false);
    return until_.includes(t.state) ? t : null;
  });
  expect(done.reason ?? "").not.toMatch(/Not done/);
  return done;
}

async function mcp<T>(key: string, name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${SITE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await res.json()) as { result?: { structuredContent: T; isError: boolean; content: { text: string }[] } };
  if (body.result?.isError) throw new Error(body.result.content[0]?.text);
  return { status: res.status, value: body.result?.structuredContent as T };
}

type TaskStatus = { state: string; transaction: string | null; reason: string | null };
const settledStatus = (key: string, taskId: string, states: string[], ms?: number) =>
  until(
    `task ${states.join("/")}`,
    async () => {
      const s = (await mcp<TaskStatus>(key, "get_task_status", { taskId })).value;
      return states.includes(s.state) ? s : null;
    },
    ms,
  );

run("Base Sepolia, end to end (contract v2)", () => {
  let vault: Address;
  let claudeId: string;
  let claudeKey: string;
  let shopId: string;
  let leaked: Hex;

  it("makes a passkey that only counts once the signed-in owner types its code", async () => {
    token = demoToken(SUB);
    await convex("mutation", "users:ensure");
    type Status = { wallet: { status: string; statusNote?: string; address: Address; deployTx: string; vault: { changeDelay: number } | null }; setup: { token: string } | null };
    const before = await convex<Status>("query", "vault:status");
    if (before.wallet?.status === "live") {
      vault = before.wallet.address;
      if (before.setup) await approve(before.setup.token);
      return;
    }
    const enrol = await convex<string>("mutation", "vault:startEnrol", { purpose: "first" });
    const info = await convex<{ challenge: string }>("query", "vault:enrolInfo", { token: enrol }, false);
    const reg = registration(info.challenge);
    const args = { token: enrol, credentialId, x, y, rpId: RP_ID, device: "Test · Node" };
    // A registration answering someone else's challenge is refused.
    await expect(convex("mutation", "vault:completeEnrol", { ...args, ...registration("not-the-challenge") }, false)).rejects.toThrow(/wasn't made for this setup link/);
    const code = await convex<string>("mutation", "vault:completeEnrol", { ...args, ...reg }, false);
    expect(code).toMatch(/^\d{6}$/);
    // The link is used up; replaying it gets nothing.
    await expect(convex("mutation", "vault:completeEnrol", { ...args, ...reg }, false)).rejects.toThrow(/expired/);
    await expect(convex("mutation", "vault:confirmEnrol", { code: code === "000000" ? "111111" : "000000" })).rejects.toThrow(/doesn't match/);
    await convex("mutation", "vault:confirmEnrol", { code });

    const live = await until(
      "the vault",
      async () => {
        const s = await convex<Status>("query", "vault:status");
        if (s.wallet.status === "error") throw new Error(s.wallet.statusNote);
        return s.wallet.status === "live" && s.setup ? s : null;
      },
      180_000,
    );
    vault = live.wallet.address;
    log("Vault deployed (v2)", live.wallet.deployTx);
    log("Setup: agents, contacts and rules", (await approve(live.setup!.token)).txHash);
    await until("the rules", async () => ((await convex<Status>("query", "vault:status")).wallet.vault?.changeDelay ? true : null));
  }, 400_000);

  it("pays small amounts at once, holds larger ones, and never pays a retried request twice", async () => {
    const agents = await convex<{ _id: string; provider: string }[]>("query", "agents:list");
    claudeId = agents.find((a) => a.provider === "claude")!._id;
    claudeKey = await convex<string>("mutation", "gateway:issueToken", { agentId: claudeId });
    const contacts = (await mcp<{ contactId: string; name: string }[]>(claudeKey, "list_contacts")).value;
    shopId = contacts.find((c) => c.name === "Blue Tokai")!.contactId;

    const small = (await mcp<{ outcome: string; taskId: string }>(claudeKey, "propose_payment", { contactId: shopId, amount: 3, reason: "Coffee" })).value;
    expect(small.outcome).toBe("paid");
    const s1 = await settledStatus(claudeKey, small.taskId, ["confirmed", "failed"]);
    expect(s1.state).toBe("confirmed");
    log("Claude pays $3 at once", s1.transaction?.split("/tx/")[1]);

    const big = (await mcp<{ outcome: string; taskId: string }>(claudeKey, "propose_payment", { contactId: shopId, amount: 6, reason: "Beans", requestId: "inv-6" })).value;
    expect(big.outcome).toBe("paid");
    const held = await settledStatus(claudeKey, big.taskId, ["held", "failed"]);
    expect(held.state).toBe("held");
    log("Claude pays $6: held for the owner", held.transaction?.split("/tx/")[1]);
    const again = (await mcp<{ outcome: string; taskId: string }>(claudeKey, "propose_payment", { contactId: shopId, amount: 6, reason: "Beans", requestId: "inv-6" })).value;
    expect(again).toMatchObject({ outcome: "duplicate", taskId: big.taskId });

    const cancelMe = (await mcp<{ outcome: string; taskId: string }>(claudeKey, "propose_payment", { contactId: shopId, amount: 5.5, reason: "Mugs", requestId: "inv-mugs" })).value;
    const heldToo = await settledStatus(claudeKey, cancelMe.taskId, ["held", "failed"]);
    expect(heldToo.state).toBe("held");
    await convex("mutation", "vault:cancelWaiting", { taskId: cancelMe.taskId });
    const cancelled = await settledStatus(claudeKey, cancelMe.taskId, ["cancelled", "confirmed"]);
    expect(cancelled.state).toBe("cancelled");

    const released = await settledStatus(claudeKey, big.taskId, ["confirmed", "failed"], 300_000);
    expect(released.state).toBe("confirmed");
    log("Held $6 released after the window", released.transaction?.split("/tx/")[1]);
  }, 500_000);

  it("turns an over-limit payment into an exact passkey approval", async () => {
    const asked = (await mcp<{ outcome: string; taskId: string }>(claudeKey, "propose_payment", { contactId: shopId, amount: 12, reason: "A bigger order" })).value;
    expect(asked.outcome).toBe("needs_approval");
    expect(asked).not.toHaveProperty("approvalUrl"); // the agent never gets the link (#6)
    // The owner finds the request in their own task list, which is where the link lives.
    const mine = await convex<{ _id: string; approvalToken?: string }[]>("query", "tasks:list");
    const done = await approve(mine.find((t) => t._id === asked.taskId)!.approvalToken!);
    expect(done.state).toBe("confirmed");
    log("Owner approves $12 by passkey", done.txHash);
  }, 200_000);

  it("strikes out a stolen agent key that skips our server", async () => {
    const tasks = execFileSync("npx", ["convex", "data", "tasks", "--format", "jsonLines", "--limit", "80"], { cwd: "../backend", encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { _id: string; agentId?: string; rail?: string; state: string; paymentId?: string });
    const paid = tasks.find((t) => t.agentId === claudeId && t.rail === "base-sepolia" && t.state === "confirmed" && t.paymentId)!;
    const sealed = JSON.parse(execFileSync("npx", ["convex", "run", "vault:agentTaskForChain", JSON.stringify({ taskId: paid._id })], { cwd: "../backend", encoding: "utf8" })) as { agentKey: string };
    // Stored sealed: a copy of the database alone yields no usable key.
    expect(sealed.agentKey).toMatch(/^enc:v1:/);
    // The test plays an attacker who also has the deployment's secret, the worst case.
    leaked = JSON.parse(execFileSync("npx", ["convex", "run", "migrations:revealAgentKeyForTest", JSON.stringify({ agentId: claudeId })], { cwd: "../backend", encoding: "utf8" })) as Hex;
    const thief = createWalletClient({ chain, transport: http(), account: privateKeyToAccount(leaked) });
    if (process.env.E2E_FUNDER_KEY) {
      // The key holds only a little gas; give the "attacker" enough for five calls.
      const funder = createWalletClient({ chain, transport: http(), account: privateKeyToAccount(process.env.E2E_FUNDER_KEY as Hex) });
      await pub.waitForTransactionReceipt({ hash: await funder.sendTransaction({ to: privateKeyToAccount(leaked).address, value: 5_000_000_000_000n }) });
    }
    // The public RPC is load-balanced; wait until the node we hit sees the gas.
    await until("gas on the stolen key", async () => (await pub.getBalance({ address: privateKeyToAccount(leaked).address })) > 1_000_000_000_000n);
    const attempt = async (label: string, contact: string, cents: number, id: Hex) => {
      // A fixed gas limit: an estimate from a lagging node can miss the extra write when the fifth strike freezes the key.
      const hash = await thief.writeContract({ address: vault, abi: policyVaultAbi, functionName: "agentPay", args: [contactIdOf(contact), toTokenUnits(cents), id, `0x${"00".repeat(32)}`], gas: 300_000n });
      await pub.waitForTransactionReceipt({ hash });
      log(label, hash);
    };
    await attempt("Stolen key: $50 → refused 2003", shopId, 5_000, paymentIdOf("thief-1"));
    await attempt("Stolen key: replay → refused 2007", shopId, 300, paid.paymentId as Hex);
    await attempt("Stolen key: unknown contact → refused 2010", "attacker", 100, paymentIdOf("thief-2"));
    await attempt("Stolen key: refused again (4 strikes)", shopId, 5_000, paymentIdOf("thief-3"));
    await attempt("Stolen key: 5th refusal freezes it", shopId, 5_000, paymentIdOf("thief-4"));
    const fields = await until("the strike-out", async () => {
      const f = (await pub.readContract({ address: vault, abi: policyVaultAbi, functionName: "agents", args: [privateKeyToAccount(leaked).address] })) as readonly unknown[];
      return f[4] === true ? f : null;
    });
    expect(fields[5]).toBe(5);
    await expect(
      thief.writeContract({ address: vault, abi: policyVaultAbi, functionName: "agentPay", args: [contactIdOf(shopId), toTokenUnits(100), paymentIdOf("thief-5"), `0x${"00".repeat(32)}`] }),
    ).rejects.toThrow(/AgentFrozen/);
  }, 300_000);

  it("unfreezes only by passkey and after the vault's delay", async () => {
    const approvalToken = await convex<string>("mutation", "agents:setStatus", { agentId: claudeId, status: "active" });
    const queued = await approve(approvalToken, ["queued", "failed"]);
    expect(queued.state).toBe("queued");
    log("Owner signs unfreeze: queued", queued.txHash);
    const applied = await until(
      "the delay",
      async () => {
        const t = await convex<Approval>("query", "approvals:get", { token: approvalToken }, false);
        return t.state === "confirmed" || t.state === "failed" ? t : null;
      },
      300_000,
    );
    expect(applied.state).toBe("confirmed");
    log("Unfreeze applied after the delay", applied.txHash);
  }, 400_000);

  it("freezes from chat, confirmed on-chain, so the old key is refused", async () => {
    await convex("mutation", "messages:send", { text: "freeze everything" });
    await until("the freeze", async () => {
      const fields = (await pub.readContract({ address: vault, abi: policyVaultAbi, functionName: "agents", args: [privateKeyToAccount(leaked).address] })) as readonly unknown[];
      return fields[4] === true;
    });
    const thief = createWalletClient({ chain, transport: http(), account: privateKeyToAccount(leaked) });
    await expect(
      thief.writeContract({ address: vault, abi: policyVaultAbi, functionName: "agentPay", args: [contactIdOf(shopId), toTokenUnits(100), paymentIdOf("after-freeze"), `0x${"00".repeat(32)}`] }),
    ).rejects.toThrow(/AgentFrozen/);
  }, 200_000);

  it("disconnects Claude and removes its key from the vault", async () => {
    const approvalToken = await convex<string>("mutation", "gateway:revoke", { agentId: claudeId });
    const res = await fetch(`${SITE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${claudeKey}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    const done = await approve(approvalToken);
    expect(done.state).toBe("confirmed");
    log("Owner removes Claude's key", done.txHash);
    const fields = (await pub.readContract({ address: vault, abi: policyVaultAbi, functionName: "agents", args: [privateKeyToAccount(leaked).address] })) as readonly unknown[];
    expect(fields[3]).toBe(false);
  }, 200_000);
});
