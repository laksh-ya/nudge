import { ConvexError } from "convex/values";
import { errorText } from "./lib/errors";
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { sha256 } from "./lib/hash";
import { telegramWebhook } from "./telegram";
import { storeAddress, paymentRequired, verifyProof } from "./commerce";
import { NETWORK, b64, unb64, type PaymentProof } from "./lib/commerce";
import { agentGuide } from "./lib/agentGuide";
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
  const opt = (k: string) => (args[k] === undefined || args[k] === null || args[k] === "" ? undefined : String(args[k]));
  const num = (k: string) => Number(args[k]);
  switch (name) {
    case "get_guide":
      return { guide: agentGuide(`${process.env.CONVEX_SITE_URL ?? ""}/mcp`) };
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
        contactId: opt("contactId"),
        toAddress: opt("toAddress"),
        name: opt("name"),
        amount: num("amount"),
        reason: str("reason"),
        requestId: opt("requestId"),
      });
    case "list_pending":
      return await ctx.runQuery(internal.agentTools.pending, { agentId });
    case "get_plan":
      return await ctx.runQuery(internal.agentTools.plan, { agentId });
    case "list_reminders":
      return await ctx.runQuery(internal.agentTools.reminders, { agentId });
    case "set_reminder":
      return await ctx.runMutation(internal.agentTools.setReminder, { agentId, text: str("text"), at: str("at"), repeat: opt("repeat") });
    case "cancel_reminder":
      return await ctx.runMutation(internal.agentTools.cancelReminder, { agentId, reminderId: str("reminderId") });
    case "add_bill":
      return await ctx.runMutation(internal.agentTools.addBill, {
        agentId,
        name: str("name"),
        amount: num("amount"),
        due: str("due"),
        repeats: opt("repeats"),
        kind: opt("kind"),
        contactId: opt("contactId"),
        payWith: opt("payWith"),
      });
    case "add_to_plan":
      return await ctx.runMutation(internal.agentTools.addPlan, { agentId, kind: str("kind"), name: str("name"), amount: num("amount"), date: str("date"), repeats: opt("repeats") });
    case "list_goals":
      return await ctx.runQuery(internal.agentTools.goals, { agentId });
    case "add_contact":
      return await ctx.runMutation(internal.agentTools.addContact, { agentId, name: str("name"), address: str("address"), kind: opt("kind") });
    case "request_limits":
      return await ctx.runMutation(internal.agentTools.requestLimits, {
        agentId,
        perPayment: num("perPayment"),
        perDay: num("perDay"),
        days: args.days === undefined ? undefined : num("days"),
        why: str("why"),
      });
    case "pay_x402":
      return await ctx.runAction(internal.commerce.payX402, { agentId, url: str("url"), maxPrice: num("maxPrice"), requestId: opt("requestId") });
    case "watch_price":
      return await ctx.runMutation(internal.commerce.watchPrice, { agentId, url: str("url"), item: str("item"), maxPrice: num("maxPrice"), days: args.days === undefined ? undefined : num("days") });
    case "list_watches":
      return await ctx.runQuery(internal.commerce.listWatches, { agentId });
    case "cancel_watch":
      return await ctx.runMutation(internal.commerce.cancelWatch, { agentId, watchId: str("watchId") });
    case "get_card":
      return await ctx.runMutation(internal.commerce.getCard, { agentId, amount: num("amount"), merchant: str("merchant"), reason: str("reason") });
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
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: "nudge", title: "Nudge", version: "0.3.0" },
        instructions: MCP_INSTRUCTIONS,
      });
    case "ping":
      return reply({});
    case "resources/list":
      return reply({ resources: [{ uri: "nudge://guide", name: "guide", title: "Nudge for agents", description: "How to act for the user with Nudge: the approval-link rule, playbooks and every tool.", mimeType: "text/markdown" }] });
    case "resources/read": {
      if (msg.params?.uri !== "nudge://guide") return fail(-32602, `Unknown resource "${String(msg.params?.uri ?? "")}". Call resources/list.`);
      return reply({ contents: [{ uri: "nudge://guide", mimeType: "text/markdown", text: agentGuide(`${process.env.CONVEX_SITE_URL ?? ""}/mcp`) }] });
    }
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

// ------------------------------------------------------------------ Nudge's demo x402 store

const storeJson = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json", ...CORS, "access-control-expose-headers": "X-PAYMENT-RESPONSE", ...headers } });

/** The catalog: every item with its x402 URL and current price. */
http.route({
  path: "/x402/store",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const base = new URL(req.url).origin;
    const items = await ctx.runMutation(internal.commerce.storeCatalog, {});
    return storeJson({
      store: "Nudge demo x402 store (Base Sepolia, test dollars)",
      payTo: storeAddress(),
      items: items.map((i) => ({ slug: i.slug, name: i.name, price: (i.priceMinor / 100).toFixed(2), url: `${base}/x402/store/item?slug=${i.slug}` })),
      howToPay: "GET an item URL: it answers 402 with an x402 `accepts` offer (scheme transfer, network base-sepolia, asset tUSD). Pay payTo on-chain, then GET again with header X-PAYMENT = base64(JSON {x402Version:1, scheme:'transfer', network:'base-sepolia', payload:{txHash}}). A Nudge agent does all of this with the pay_x402 tool.",
    });
  }),
});

http.route({
  path: "/x402/store/item",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const slug = url.searchParams.get("slug") ?? "";
    const row = await ctx.runMutation(internal.commerce.storeItem, { slug });
    if (!row) return storeJson({ error: `No item "${slug}". See /x402/store.` }, 404);
    const resource = `${url.origin}/x402/store/item?slug=${row.slug}`;
    const header = req.headers.get("x-payment");
    if (!header) return storeJson(paymentRequired(resource, row), 402);
    const proof = unb64<PaymentProof>(header);
    if (!proof) return storeJson({ ...paymentRequired(resource, row), error: "X-PAYMENT isn't base64 JSON" }, 402);
    const check = await verifyProof(proof, storeAddress(), row);
    if (!check.ok) return storeJson({ ...paymentRequired(resource, row), error: check.why }, 402);
    if (!(await ctx.runMutation(internal.commerce.redeem, { proof: check.key, slug: row.slug }))) {
      return storeJson({ ...paymentRequired(resource, row), error: "That payment was already used for a purchase" }, 402);
    }
    const settlement = b64({ success: true, network: NETWORK, transaction: check.tx ?? null, payer: null });
    return storeJson({ item: row.name, paid: (row.priceMinor / 100).toFixed(2), content: row.content }, 200, { "X-PAYMENT-RESPONSE": settlement });
  }),
});

/** Demo control: drop (or restore) an item's price to try a price watch. Resets after a day. */
http.route({
  path: "/x402/store/price",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const slug = url.searchParams.get("slug") ?? "";
    const price = url.searchParams.get("price");
    const cents = price === null ? undefined : Math.round(Number(price) * 100);
    if (cents !== undefined && !(cents > 0)) return storeJson({ error: "price must be a positive number of dollars" }, 400);
    const row = await ctx.runMutation(internal.commerce.setStorePrice, { slug, priceMinor: cents });
    if (!row) return storeJson({ error: `No item "${slug}"` }, 404);
    return storeJson({ slug: row.slug, price: (row.priceMinor / 100).toFixed(2) });
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
    resource_name: "Nudge MCP",
    resource_documentation: `${process.env.WEB_URL ?? "https://nudge-wallet.vercel.app"}/agents/docs`,
    scopes_supported: ["read", "prepare", "spend", "request"],
  }),
);
http.route({ path: "/.well-known/oauth-protected-resource", method: "GET", handler: protectedResource });
http.route({ path: "/.well-known/oauth-protected-resource/mcp", method: "GET", handler: protectedResource });

http.route({ path: "/telegram", method: "POST", handler: telegramWebhook });

export default http;
