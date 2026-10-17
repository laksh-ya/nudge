/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { s256 } from "./lib/oauth";

/**
 * MCP OAuth 2.1 (issue #14) behind MCP_OAUTH. Off: nothing but bearer keys. On: dynamic registration,
 * authorize → owner consent on the dashboard → code + PKCE → a per-assistant key that the gateway
 * treats exactly like one from the Agents screen.
 */
vi.mock("./lib/relayer", () => {
  const pool = { enqueueAction: vi.fn(async () => "queued") };
  return { relayer: pool, agentPool: pool, lanePool: () => pool, laneOf: () => 0, laneCount: () => 1, MAX_LANES: 4 };
});
const modules = import.meta.glob(["./**/*.ts", "./**/*.js", "!./**/*.test.ts"]);
afterEach(() => vi.unstubAllEnvs());

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(20) + "-verifier-0123456789abcdefghij";

async function setup() {
  const t = convexTest(schema, modules);
  const alice = t.withIdentity({ subject: "alice", issuer: "https://test.local", tokenIdentifier: "https://test.local|alice" });
  await alice.mutation(api.users.ensure, {});
  const post = (path: string, body: string, type = "application/json") => t.fetch(path, { method: "POST", headers: { "content-type": type }, body });
  return { t, alice, post };
}

async function registered() {
  const s = await setup();
  const res = await s.post("/oauth/register", JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT] }));
  expect(res.status).toBe(201);
  const { client_id } = (await res.json()) as { client_id: string };
  return { ...s, clientId: client_id, challenge: await s256(VERIFIER) };
}

async function consented(scopes: ("read" | "prepare" | "spend" | "request")[] = ["read"]) {
  const r = await registered();
  const to = await r.alice.mutation(api.oauth.approve, {
    clientId: r.clientId, redirectUri: REDIRECT, codeChallenge: r.challenge, codeChallengeMethod: "S256", state: "xyz",
    scopes, perPaymentMinor: 0, dailyCapMinor: 0, hidesBalances: true, days: 30,
  });
  const url = new URL(to);
  return { ...r, url, code: url.searchParams.get("code")! };
}

const tokenBody = (o: Record<string, string>) => new URLSearchParams({ grant_type: "authorization_code", redirect_uri: REDIRECT, ...o }).toString();

describe("OAuth off (the default)", () => {
  it("serves no authorization server and refuses every OAuth endpoint", async () => {
    const { t, alice, post } = await setup();
    expect((await t.fetch("/.well-known/oauth-authorization-server", { method: "GET" })).status).toBe(404);
    expect((await post("/oauth/register", JSON.stringify({ client_name: "x", redirect_uris: [REDIRECT] }))).status).toBe(404);
    expect((await t.fetch(`/oauth/authorize?client_id=x&redirect_uri=${encodeURIComponent(REDIRECT)}`, { method: "GET" })).status).toBe(404);
    expect((await post("/oauth/token", "grant_type=authorization_code", "application/x-www-form-urlencoded")).status).toBe(404);
    const meta = await (await t.fetch("/.well-known/oauth-protected-resource", { method: "GET" })).json();
    expect(meta).not.toHaveProperty("authorization_servers");
    expect(await alice.query(api.oauth.consentInfo, { clientId: "x", redirectUri: REDIRECT })).toEqual({ enabled: false });
    await expect(
      alice.mutation(api.oauth.approve, { clientId: "x", redirectUri: REDIRECT, codeChallenge: "c".repeat(43), codeChallengeMethod: "S256", scopes: ["read"], perPaymentMinor: 0, dailyCapMinor: 0, hidesBalances: true, days: 30 }),
    ).rejects.toThrow(/isn't available yet/);
  });
});

describe("OAuth on", () => {
  const on = () => {
    vi.stubEnv("MCP_OAUTH", "on");
    vi.stubEnv("WEB_URL", "https://wallet.example");
  };

  it("advertises itself in protected-resource and authorization-server metadata", async () => {
    on();
    const { t } = await setup();
    const pr = await (await t.fetch("/.well-known/oauth-protected-resource", { method: "GET" })).json();
    expect(pr.authorization_servers).toHaveLength(1);
    const as = await (await t.fetch("/.well-known/oauth-authorization-server", { method: "GET" })).json();
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(as.registration_endpoint).toMatch(/\/oauth\/register$/);
  });

  it("registers only https or loopback redirect URIs", async () => {
    on();
    const { post } = await setup();
    for (const uri of ["http://evil.example/cb", "javascript:alert(1)", "https://x.example/cb#frag"]) {
      expect((await post("/oauth/register", JSON.stringify({ client_name: "x", redirect_uris: [uri] }))).status).toBe(400);
    }
    expect((await post("/oauth/register", JSON.stringify({ client_name: "Claude Code", redirect_uris: ["http://localhost:33418/callback"] }))).status).toBe(201);
  });

  it("authorize never redirects to an unregistered URI, requires PKCE, then sends the owner to the dashboard", async () => {
    on();
    const r = await registered();
    const go = (q: Record<string, string>) => r.t.fetch(`/oauth/authorize?${new URLSearchParams(q)}`, { method: "GET" });
    const bad = await go({ client_id: r.clientId, redirect_uri: "https://evil.example/cb", response_type: "code", code_challenge: r.challenge, code_challenge_method: "S256" });
    expect(bad.status).toBe(400);
    expect(bad.headers.get("location")).toBeNull();
    const plain = await go({ client_id: r.clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: "abc", code_challenge_method: "plain", state: "s1" });
    expect(plain.status).toBe(302);
    expect(new URL(plain.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    const ok = await go({ client_id: r.clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: r.challenge, code_challenge_method: "S256", state: "s1", scope: "read prepare admin" });
    const consent = new URL(ok.headers.get("location")!);
    expect(consent.origin + consent.pathname).toBe("https://wallet.example/agents/authorize");
    expect(consent.searchParams.get("scope")).toBe("read prepare");
    expect(consent.searchParams.get("state")).toBe("s1");
    expect(await r.alice.query(api.oauth.consentInfo, { clientId: r.clientId, redirectUri: REDIRECT })).toEqual({ enabled: true, valid: true, name: "Claude", returnsTo: "claude.ai" });
  });

  it("code + verifier gives a key the gateway treats like any other: read-only consent can't pay", async () => {
    on();
    const c = await consented(["read"]);
    expect(c.url.origin + c.url.pathname).toBe(REDIRECT);
    expect(c.url.searchParams.get("state")).toBe("xyz");
    const res = await c.post("/oauth/token", tokenBody({ code: c.code, client_id: c.clientId, code_verifier: VERIFIER }), "application/x-www-form-urlencoded");
    expect(res.status).toBe(200);
    const tok = (await res.json()) as { access_token: string; token_type: string; scope: string; expires_in: number };
    expect(tok).toMatchObject({ token_type: "Bearer", scope: "read" });
    expect(tok.access_token).toMatch(/^aw_/);
    const rpc = (method: string, params?: object) =>
      c.t.fetch("/mcp", { method: "POST", headers: { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((x) => x.json());
    const list = await rpc("tools/list");
    expect(list.result.tools.map((x: { name: string }) => x.name)).not.toContain("propose_payment");
    const pay = await rpc("tools/call", { name: "propose_payment", arguments: { contactId: "x", amount: 3, reason: "x" } });
    expect(pay.result.isError).toBe(true);
    expect(pay.result.content[0].text).toMatch(/Claude can only read/);
    // A new assistant row, never an existing one's key replaced.
    const agents = await c.t.run((ctx) => ctx.db.query("agents").collect());
    expect(agents.filter((a) => a.name === "Claude")).toHaveLength(1);
  });

  it("a code works once, only with the right verifier, client and redirect URI", async () => {
    on();
    const c = await consented();
    const ex = (o: Record<string, string>) => c.post("/oauth/token", tokenBody(o), "application/x-www-form-urlencoded").then(async (x) => ({ status: x.status, body: await x.json() }));
    const wrong = await ex({ code: c.code, client_id: c.clientId, code_verifier: "w".repeat(43) });
    expect(wrong).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    // Burnt by the failed attempt: a stolen code can't be retried.
    expect(await ex({ code: c.code, client_id: c.clientId, code_verifier: VERIFIER })).toMatchObject({ status: 400, body: { error: "invalid_grant" } });

    const d = await consented();
    expect(await ex({ code: d.code, client_id: "awc_other", code_verifier: VERIFIER })).toMatchObject({ body: { error: "invalid_grant" } });
    const e = await consented();
    expect((await e.post("/oauth/token", tokenBody({ code: e.code, client_id: e.clientId, code_verifier: VERIFIER }), "application/x-www-form-urlencoded")).status).toBe(200);
    expect((await e.post("/oauth/token", tokenBody({ code: e.code, client_id: e.clientId, code_verifier: VERIFIER }), "application/x-www-form-urlencoded")).status).toBe(400);
  });

  it("consent can't be forged for an unregistered redirect URI or without PKCE", async () => {
    on();
    const r = await registered();
    const base = { clientId: r.clientId, codeChallengeMethod: "S256", scopes: ["read" as const], perPaymentMinor: 0, dailyCapMinor: 0, hidesBalances: true, days: 30 };
    await expect(r.alice.mutation(api.oauth.approve, { ...base, redirectUri: "https://evil.example/cb", codeChallenge: r.challenge })).rejects.toThrow(/isn't valid/);
    await expect(r.alice.mutation(api.oauth.approve, { ...base, redirectUri: REDIRECT, codeChallenge: "short" })).rejects.toThrow(/isn't valid/);
    await expect(r.t.mutation(api.oauth.approve, { ...base, redirectUri: REDIRECT, codeChallenge: r.challenge })).rejects.toThrow(/Not signed in/);
  });
});
