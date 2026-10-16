/**
 * Shared pieces of the Base Sepolia end-to-end suites: a demo-sandbox token, Convex and MCP calls,
 * a software passkey that answers exactly like a browser, and transaction logging.
 */
import { createPrivateKey, randomBytes, sign as nodeSign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha2";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { expect } from "vitest";
import { CHAIN_ID, EXPLORER, actionDigest, type Op } from "./vault";
import { base64url, toWebAuthnAuth } from "./webauthn";

export const CONVEX = process.env.E2E_CONVEX_URL;
export const JWK = process.env.E2E_DEMO_JWK;
export const SITE = CONVEX?.replace(".convex.cloud", ".convex.site");
export const RP_ID = "agent-wallet-approve.vercel.app";
export const enabled = Boolean(CONVEX && JWK);

export const chain = {
  id: CHAIN_ID,
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia.base.org"] } },
} as const;
export const pub = createPublicClient({ chain, transport: http() });

/** One owner, one sandbox, one software passkey per suite run. `name` keeps suites' state apart. */
export function harness(name: string) {
  const hashFile = join(tmpdir(), `agent-wallet-${name}-hashes.json`);
  const hashes: Record<string, string> = {};
  const log = (label: string, hash?: string | null) => {
    if (!hash) return;
    hashes[label] = `${EXPLORER}/tx/${hash}`;
    writeFileSync(hashFile, JSON.stringify(hashes, null, 2));
  };

  const STATE = join(tmpdir(), `agent-wallet-${name}-state.json`);
  const saved = existsSync(STATE) ? (JSON.parse(readFileSync(STATE, "utf8")) as { sub: string; priv: string; credentialId: string }) : null;
  const sub = saved?.sub ?? `e2e${randomBytes(15).toString("hex")}`;
  const priv = saved ? Uint8Array.from(Buffer.from(saved.priv, "hex")) : p256.utils.randomPrivateKey();
  const point = p256.getPublicKey(priv, false);
  const x = `0x${Buffer.from(point.slice(1, 33)).toString("hex")}`;
  const y = `0x${Buffer.from(point.slice(33)).toString("hex")}`;
  const credentialId = saved?.credentialId ?? base64url(randomBytes(16));
  if (enabled) writeFileSync(STATE, JSON.stringify({ sub, priv: Buffer.from(priv).toString("hex"), credentialId }));

  /** A demo-sandbox token, signed the way apps/web/app/api/demo/token does it. */
  function demoToken() {
    const jwk = JSON.parse(readFileSync(JWK!, "utf8")) as { kid?: string };
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const head = enc({ alg: "ES256", typ: "JWT", kid: jwk.kid ?? "demo-1" });
    const body = enc({ iss: "https://demo.agent-wallet.app", aud: "agent-wallet-demo", sub, iat: now, exp: now + 3600 });
    const sig = nodeSign("sha256", Buffer.from(`${head}.${body}`), { key: createPrivateKey({ key: jwk as never, format: "jwk" }), dsaEncoding: "ieee-p1363" });
    return `${head}.${body}.${sig.toString("base64url")}`;
  }
  const token = enabled ? demoToken() : "";

  async function convex<T>(kind: "query" | "mutation" | "action", path: string, args: Record<string, unknown> = {}, auth = true): Promise<T> {
    const res = await fetch(`${CONVEX}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    const body = (await res.json()) as { status: string; value?: T; errorMessage?: string };
    if (body.status !== "success") throw new Error(`${path}: ${body.errorMessage}`);
    return body.value as T;
  }

  /** What navigator.credentials.create returns for the key: our challenge, our site, the key in CBOR. */
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

  type Status = { wallet: { status: string; statusNote?: string; address: Address; deployTx: string; vault: { changeDelay: number } | null }; setup: { token: string } | null };

  /** A sandbox with a live vault whose setup is approved; reuses the one from an earlier run. */
  async function liveVault(): Promise<{ vault: Address; deployTx?: string; setupTx?: string | null }> {
    await convex("mutation", "users:ensure");
    const before = await convex<Status>("query", "vault:status");
    if (before.wallet?.status === "live") {
      if (before.setup) await approve(before.setup.token);
      return { vault: before.wallet.address };
    }
    const enrol = await convex<string>("mutation", "vault:startEnrol", { purpose: "first" });
    const info = await convex<{ challenge: string }>("query", "vault:enrolInfo", { token: enrol }, false);
    const code = await convex<string>("mutation", "vault:completeEnrol", { token: enrol, credentialId, x, y, rpId: RP_ID, device: "Test · Node", ...registration(info.challenge) }, false);
    const confirmed = await convex<{ error?: string }>("mutation", "vault:confirmEnrol", { code });
    if (confirmed.error) throw new Error(confirmed.error);
    const live = await until(
      "the vault",
      async () => {
        const s = await convex<Status>("query", "vault:status");
        if (s.wallet.status === "error") throw new Error(s.wallet.statusNote);
        return s.wallet.status === "live" && s.setup ? s : null;
      },
      180_000,
    );
    const setup = await approve(live.setup!.token);
    await until("the rules", async () => ((await convex<Status>("query", "vault:status")).wallet.vault?.changeDelay ? true : null));
    return { vault: live.wallet.address, deployTx: live.wallet.deployTx, setupTx: setup.txHash };
  }

  return { log, hashes, sub, x, y, credentialId, token, convex, registration, assertion, approve, liveVault };
}

export type Approval = {
  state: string;
  txHash: string | null;
  reason?: string;
  onchain: { action: { op: Op; data: Hex; nonce: string | number; deadline: number }; vault: Address } | null;
};

export async function until<T>(what: string, read: () => Promise<T | null | undefined | false>, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export async function mcp<T>(key: string, name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${SITE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await res.json()) as { result?: { structuredContent: T; isError: boolean; content: { text: string }[] } };
  if (body.result?.isError) throw new Error(body.result.content[0]?.text);
  return { status: res.status, value: body.result?.structuredContent as T };
}

export type TaskStatus = { state: string; transaction: string | null; reason: string | null };

export const taskState = (key: string, taskId: string, states: string[], ms?: number) =>
  until(
    `task ${states.join("/")}`,
    async () => {
      const s = (await mcp<TaskStatus>(key, "get_task_status", { taskId })).value;
      return states.includes(s.state) ? s : null;
    },
    ms,
  );
