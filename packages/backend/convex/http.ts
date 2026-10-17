import { ConvexError } from "convex/values";
import { errorText } from "./lib/errors";
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { sha256 } from "./lib/hash";
import { telegramWebhook } from "./telegram";
import { MCP_INSTRUCTIONS, findTool, invalidArgs, toolDenied, toolsFor } from "./lib/mcp";

/** JSON-RPC batches are capped; MCP itself dropped batching in 2025-06-18. */
const MAX_BATCH = 5;

const http = httpRouter();

/**
 * Remote MCP server (Streamable HTTP, JSON responses). Each outside assistant authenticates
 * with its own bearer token issued from the Agents screen. The tool catalog lives in lib/mcp.ts,
 * which the public docs page (/agents/docs) renders too.
 */
type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

function isRpc(value: unknown): value is Rpc {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const msg = value as Record<string, unknown>;
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string" || !msg.method) return false;
  if (msg.params !== undefined && (msg.params === null || typeof msg.params !== "object" || Array.isArray(msg.params))) return false;
  if (msg.id !== undefined && msg.id !== null && typeof msg.id !== "string" && (typeof msg.id !== "number" || !Number.isFinite(msg.id))) return false;
  // MCP tool calls are requests. A payment without a response id cannot be tracked safely.
  return msg.id !== undefined || msg.method.startsWith("notifications/");
}

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
      throw new ConvexError(`Unknown tool ${name}`);
  }
}

function cleanError(e: unknown) {
  return errorText(e);
}

async function handle(ctx: ActionCtx, agent: Caller, value: unknown) {
  if (!isRpc(value)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid JSON-RPC 2.0 request" } };
  const msg = value;
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
    const token = auth.match(/^Bearer\s+(aw_[A-Za-z0-9_-]{20,})$/i)?.[1];
    if (!token) return unauthorized(req, "Invalid or revoked access key. Ask the owner for a new key from the Agents screen.");
    const agent = await ctx.runQuery(internal.gateway.agentByToken, { tokenHash: await sha256(token) });
    if (!agent || agent.status === "revoked") return unauthorized(req, "Invalid or revoked access key. Ask the owner for a new key from the Agents screen.");
    if (agent.expiresAt <= Date.now()) return unauthorized(req, `${agent.name}'s access has expired. Ask the owner to extend it in Agents → ${agent.name} → Limits.`);
    if (agent.status === "frozen") return rpcError(-32003, `${agent.name} is frozen by its owner. Nothing can be read or paid until the owner unfreezes it on the Agents screen.`, 403);
    let body: unknown;
    try {
      body = await req.json();
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
 * only: no authorization server is listed until MCP OAuth ships (issue #14).
 */
const protectedResource = httpAction(async (_ctx, req) =>
  json({
    resource: `${new URL(req.url).origin}/mcp`,
    bearer_methods_supported: ["header"],
    resource_name: "Agent Wallet MCP",
    resource_documentation: `${process.env.WEB_URL ?? "https://agent-wallet-nu.vercel.app"}/agents/docs`,
    scopes_supported: ["read", "prepare", "spend", "request"],
  }),
);
http.route({ path: "/.well-known/oauth-protected-resource", method: "GET", handler: protectedResource });
http.route({ path: "/.well-known/oauth-protected-resource/mcp", method: "GET", handler: protectedResource });

http.route({ path: "/telegram", method: "POST", handler: telegramWebhook });

export default http;
