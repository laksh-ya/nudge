import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { sha256 } from "./lib/hash";
import { telegramWebhook } from "./telegram";
import { MCP_INSTRUCTIONS, findTool, invalidArgs, toolDenied, toolsFor } from "./lib/mcp";
import { CHALLENGE_RE, OAUTH_SCOPES, oauthEnabled, parseScope, webUrl } from "./lib/oauth";

/** JSON-RPC batches are capped; MCP itself dropped batching in 2025-06-18. */
const MAX_BATCH = 5;

const http = httpRouter();

/**
 * Remote MCP server (Streamable HTTP, JSON responses). Each outside assistant authenticates
 * with its own bearer token issued from the Agents screen. The tool catalog lives in lib/mcp.ts,
 * which the public docs page (/agents/docs) renders too.
 */
type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

/**
 * Browser-based MCP clients (MCP Inspector, web agents) need CORS. Keys travel in a header, never a
 * cookie, so allowing any origin exposes nothing a caller doesn't already hold.
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version",
  "access-control-expose-headers": "WWW-Authenticate, Retry-After, Mcp-Session-Id",
  "access-control-max-age": "86400",
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS, ...headers } });

const rpcError = (code: number, message: string, status: number, headers?: Record<string, string>) =>
  json({ jsonrpc: "2.0", id: null, error: { code, message } }, status, headers);

/** RFC 9728: where a client learns how to get a token for this server. */
function resourceMetadataUrl(req: Request) {
  return `${new URL(req.url).origin}/.well-known/oauth-protected-resource`;
}

function unauthorized(req: Request, message: string) {
  return rpcError(-32001, message, 401, { "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl(req)}"` });
}

type Caller = { _id: Id<"agents">; name: string; scopes: string[] };

async function callTool(ctx: ActionCtx, agentId: Id<"agents">, name: string, args: Record<string, unknown>) {
  const str = (k: string) => String(args[k] ?? "");
  const num = (k: string) => Number(args[k]);
  switch (name) {
    case "get_my_limits":
      return await ctx.runQuery(internal.gateway.myLimits, { agentId });
    case "get_overview":
      return await ctx.runQuery(internal.gateway.overview, { agentId });
    case "can_afford":
      return await ctx.runQuery(internal.gateway.canAfford, { agentId, amount: num("amount") });
    case "list_bills":
      return await ctx.runQuery(internal.gateway.bills, { agentId });
    case "spending_this_month":
      return await ctx.runQuery(internal.gateway.spending, { agentId });
    case "list_contacts":
      return await ctx.runQuery(internal.gateway.contacts, { agentId });
    case "propose_payment":
      return await ctx.runMutation(internal.gateway.proposePayment, {
        agentId,
        contactId: str("contactId"),
        amount: num("amount"),
        reason: str("reason"),
        requestId: args.requestId === undefined ? undefined : str("requestId"),
      });
    case "get_task_status":
      return await ctx.runQuery(internal.gateway.taskStatus, { agentId, taskId: str("taskId") });
    case "get_mandate":
      return await ctx.runQuery(internal.gateway.mandate, { agentId });
    case "cancel_task":
      return await ctx.runMutation(internal.gateway.cancelTask, { agentId, taskId: str("taskId") });
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

function cleanError(e: unknown) {
  const m = e instanceof Error ? e.message : String(e);
  return (m.match(/Uncaught Error: ([^\n]+)/)?.[1] ?? m).slice(0, 200);
}

async function handle(ctx: ActionCtx, agent: Caller, msg: Rpc) {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  // Refusals a model can read and relay. Arguments and permissions come back as tool errors, not
  // protocol errors, so the model sees them and can correct itself or tell the user.
  const toolError = (text: string) => reply({ content: [{ type: "text", text }], isError: true });
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-wallet", title: "Agent Wallet", version: "0.2.0" },
        instructions: MCP_INSTRUCTIONS,
      });
    case "ping":
      return reply({});
    case "tools/list":
      // Only what this key may call: a read-only assistant never sees propose_payment.
      return reply({ tools: toolsFor(agent.scopes) });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const tool = findTool(name);
      if (!tool) return fail(-32602, `Unknown tool "${name}". Call tools/list for the tools this key can use.`);
      const denied = toolDenied(agent.name, agent.scopes, name);
      if (denied) return toolError(denied);
      const args = msg.params?.arguments ?? {};
      const bad = invalidArgs(tool, args);
      if (bad) return toolError(bad);
      try {
        const out = await callTool(ctx, agent._id, name, args as Record<string, unknown>);
        return reply({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: structured(out), isError: false });
      } catch (e) {
        return toolError(cleanError(e));
      }
    }
    default:
      if (msg.method?.startsWith("notifications/")) return null;
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

/** MCP requires structuredContent to be an object; clients now reject a bare array (list_contacts, list_bills). */
function structured(out: unknown): Record<string, unknown> {
  if (Array.isArray(out)) return { items: out };
  if (out !== null && typeof out === "object") return out as Record<string, unknown>;
  return { result: out ?? null };
}

http.route({
  path: "/mcp",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const auth = req.headers.get("authorization") ?? "";
    if (!auth.trim()) return unauthorized(req, "Missing access key. Send the header Authorization: Bearer <key>, using a key from the owner's Agents screen.");
    const token = auth.match(/^Bearer\s+(aw_[A-Za-z0-9_-]{20,})$/)?.[1];
    if (!token) return unauthorized(req, "Invalid or revoked access key. Ask the owner for a new key from the Agents screen.");
    const agent = await ctx.runQuery(internal.gateway.agentByToken, { tokenHash: await sha256(token) });
    if (!agent) return unauthorized(req, "Invalid or revoked access key. Ask the owner for a new key from the Agents screen.");
    if (agent.status === "frozen") return rpcError(-32003, `${agent.name} is frozen by its owner. Nothing can be read or paid until the owner unfreezes it on the Agents screen.`, 403);
    let body: Rpc | Rpc[];
    try {
      body = (await req.json()) as Rpc | Rpc[];
    } catch {
      return rpcError(-32700, "Parse error: the body must be JSON-RPC 2.0", 400);
    }
    if (Array.isArray(body) && (body.length === 0 || body.length > MAX_BATCH)) {
      return rpcError(-32600, `Send 1 to ${MAX_BATCH} calls per request`, 400);
    }
    // Every call counts against the rate limit, batched or not.
    if (!(await ctx.runMutation(internal.gateway.allow, { agentId: agent._id, calls: Array.isArray(body) ? body.length : 1 }))) {
      return rpcError(-32029, "Too many requests: 60 calls a minute per assistant. Wait a minute and try again.", 429, { "retry-after": "60" });
    }
    const caller: Caller = { _id: agent._id, name: agent.name, scopes: agent.scopes };
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handle(ctx, caller, m)))).filter(Boolean);
      return out.length ? json(out) : new Response(null, { status: 202, headers: CORS });
    }
    const out = await handle(ctx, caller, body);
    return out ? json(out) : new Response(null, { status: 202, headers: CORS });
  }),
});

http.route({
  path: "/mcp",
  method: "GET",
  // No server-sent stream: every reply comes back on the POST.
  handler: httpAction(async () => new Response("Use POST with JSON-RPC.", { status: 405, headers: { allow: "POST, OPTIONS", ...CORS } })),
});

http.route({
  path: "/mcp",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: CORS })),
});

/**
 * RFC 9728 protected-resource metadata, linked from every 401. Bearer keys from the Agents screen
 * always work; an authorization server is listed only when MCP OAuth is on (MCP_OAUTH=on, #14).
 */
const protectedResource = httpAction(async (_ctx, req) => {
  const origin = new URL(req.url).origin;
  return json({
    resource: `${origin}/mcp`,
    ...(oauthEnabled() ? { authorization_servers: [origin] } : {}),
    bearer_methods_supported: ["header"],
    resource_name: "Agent Wallet MCP",
    resource_documentation: `${webUrl()}/agents/docs`,
    scopes_supported: [...OAUTH_SCOPES],
  });
});
http.route({ path: "/.well-known/oauth-protected-resource", method: "GET", handler: protectedResource });
http.route({ path: "/.well-known/oauth-protected-resource/mcp", method: "GET", handler: protectedResource });

// ---- MCP OAuth 2.1 (authorization code + PKCE, dynamic registration). Off unless MCP_OAUTH=on. ----

const oauthOff = () => json({ error: "not_found", error_description: "OAuth isn't available on this server. Use an access key from the Agents screen." }, 404);
const oauthError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);
const preflight = httpAction(async () => new Response(null, { status: 204, headers: CORS }));

/** RFC 8414 authorization server metadata. */
http.route({
  path: "/.well-known/oauth-authorization-server",
  method: "GET",
  handler: httpAction(async (_ctx, req) => {
    if (!oauthEnabled()) return oauthOff();
    const origin = new URL(req.url).origin;
    return json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [...OAUTH_SCOPES],
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${webUrl()}/agents/docs`,
    });
  }),
});

/** RFC 7591 dynamic client registration (public clients). */
http.route({
  path: "/oauth/register",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!oauthEnabled()) return oauthOff();
    let body: { client_name?: unknown; redirect_uris?: unknown; token_endpoint_auth_method?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return oauthError("invalid_client_metadata", "Send JSON client metadata");
    }
    if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
      return oauthError("invalid_client_metadata", "Only public clients (token_endpoint_auth_method none, with PKCE) are supported");
    }
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    const out = await ctx.runMutation(internal.oauth.register, { name: String(body.client_name ?? ""), redirectUris: uris });
    if ("error" in out) return oauthError(out.error, out.description, out.error === "temporarily_unavailable" ? 429 : 400);
    return json(
      {
        client_id: out.clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: out.name,
        redirect_uris: out.redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
      },
      201,
    );
  }),
});
http.route({ path: "/oauth/register", method: "OPTIONS", handler: preflight });

/**
 * The owner's browser arrives here from the client. A bad client or redirect URI gets an error page
 * and is never redirected; otherwise the owner goes to the dashboard to sign in and consent.
 */
http.route({
  path: "/oauth/authorize",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    if (!oauthEnabled()) return oauthOff();
    const p = new URL(req.url).searchParams;
    const clientId = p.get("client_id") ?? "";
    const redirectUri = p.get("redirect_uri") ?? "";
    if (!(await ctx.runQuery(internal.oauth.checkClient, { clientId, redirectUri }))) {
      return new Response("This connection request isn't valid: unknown client or redirect URI. Start again from your assistant.", {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    const back = (error: string, description: string) => {
      const u = new URL(redirectUri);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", description);
      const state = p.get("state");
      if (state) u.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { location: u.toString(), "cache-control": "no-store" } });
    };
    if (p.get("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is supported");
    if (p.get("code_challenge_method") !== "S256" || !CHALLENGE_RE.test(p.get("code_challenge") ?? "")) return back("invalid_request", "PKCE with S256 is required");
    const consent = new URL(`${webUrl()}/agents/authorize`);
    consent.searchParams.set("client_id", clientId);
    consent.searchParams.set("redirect_uri", redirectUri);
    consent.searchParams.set("code_challenge", p.get("code_challenge")!);
    consent.searchParams.set("scope", parseScope(p.get("scope")).join(" "));
    const state = p.get("state");
    if (state) consent.searchParams.set("state", state);
    return new Response(null, { status: 302, headers: { location: consent.toString(), "cache-control": "no-store" } });
  }),
});

/** Code + PKCE verifier for an access token (a per-assistant key, like the Agents screen issues). */
http.route({
  path: "/oauth/token",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!oauthEnabled()) return oauthOff();
    let form: URLSearchParams;
    try {
      form = new URLSearchParams(await req.text());
    } catch {
      return oauthError("invalid_request", "Send application/x-www-form-urlencoded");
    }
    if (form.get("grant_type") !== "authorization_code") return oauthError("unsupported_grant_type", "Only authorization_code is supported");
    const args = { code: form.get("code") ?? "", clientId: form.get("client_id") ?? "", redirectUri: form.get("redirect_uri") ?? "", codeVerifier: form.get("code_verifier") ?? "" };
    if (!args.code || !args.clientId || !args.redirectUri) return oauthError("invalid_request", "code, client_id, redirect_uri and code_verifier are required");
    const out = await ctx.runMutation(internal.oauth.exchange, args);
    if ("error" in out) return oauthError(out.error, out.description);
    return json({ access_token: out.token, token_type: "Bearer", expires_in: out.expiresIn, scope: out.scope });
  }),
});
http.route({ path: "/oauth/token", method: "OPTIONS", handler: preflight });

http.route({ path: "/telegram", method: "POST", handler: telegramWebhook });

export default http;
