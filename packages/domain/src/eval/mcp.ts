/**
 * Claude over MCP, on the owner's Claude subscription (no API key): Claude Code in headless mode
 * (`claude -p`) is the assistant, connected over HTTP to
 *
 * - the wallet's real MCP endpoint (http.ts, POST /mcp), served locally and backed by this case's
 *   simulator and vault: the "full system" an outside assistant gets; or
 * - a naive wallet with a send_money tool that pays whatever it is asked: the "model alone".
 *
 * Claude Code runs with a replaced system prompt, no built-in tools, only this MCP server, and
 * every CLAUDE.md excluded, so nothing from the machine it runs on reaches the model.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { ToolCall } from "./judge";
import type { Sim } from "./sim";

type Served = { url: string; close: () => Promise<void> };

async function bodyOf(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function listen(handle: (req: IncomingMessage, body: string) => Promise<{ status: number; headers: Record<string, string>; body: string }>): Promise<Served> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await bodyOf(req);
      const out = await handle(req, body);
      if (process.env.EVAL_TRACE) console.log("MCP", req.method, body.slice(0, 120).replace(/\s+/g, " "), "->", out.status, out.body.slice(0, 160).replace(/\s+/g, " "));
      res.writeHead(out.status, out.headers);
      res.end(out.body);
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(e instanceof Error ? e.message : String(e));
    }
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, close: () => new Promise((r) => server.close(() => r())) }),
    ),
  );
}

type Rpc = { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };

/**
 * The wallet's own MCP route from http.ts, run against `sim`. `within` puts each request in the
 * conversation's context (so queued transactions land on this simulator) and `settle` runs what the
 * request queued, as the backend's workpool would. Tool calls and their results go to `calls`.
 */
export async function serveWallet(sim: Sim, calls: ToolCall[], within: <T>(f: () => Promise<T>) => Promise<T>, settle: () => Promise<unknown>): Promise<Served> {
  const http = (await import("../../../backend/convex/http")).default as unknown as { lookup: (path: string, method: string) => [{ _handler: (ctx: unknown, req: Request) => Promise<Response> }, string, string] | null };
  return await listen(async (req, body) => {
    const route = http.lookup("/mcp", req.method ?? "GET");
    if (!route) return { status: 404, headers: {}, body: "" };
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const request = new Request(`http://127.0.0.1/mcp`, { method: req.method, headers, body: req.method === "POST" ? body : undefined });
    const response = await within(async () => {
      const r = await route[0]._handler(sim.actionCtx(), request);
      await settle();
      return r;
    });
    let text = await response.text();
    // Issue #46: the wallet returns arrays as structuredContent, which MCP clients (Claude Code
    // included) reject. Until the fix lands, apply it here so the eval measures behaviour, not that bug.
    if (process.env.EVAL_MCP_AS_IS !== "1" && text.includes('"structuredContent":[')) {
      const fix = (r: { result?: { structuredContent?: unknown } }) => {
        if (Array.isArray(r.result?.structuredContent)) r.result!.structuredContent = { items: r.result!.structuredContent };
        return r;
      };
      const parsed = JSON.parse(text) as { result?: { structuredContent?: unknown } } | { result?: { structuredContent?: unknown } }[];
      text = JSON.stringify(Array.isArray(parsed) ? parsed.map(fix) : fix(parsed));
    }
    // Record tool calls with what the wallet answered.
    try {
      const sent = JSON.parse(body) as Rpc | Rpc[];
      const got = text ? (JSON.parse(text) as { id?: unknown; result?: { structuredContent?: unknown; content?: { text: string }[] } } | { id?: unknown; result?: unknown }[]) : [];
      const replies = Array.isArray(got) ? got : [got];
      for (const m of Array.isArray(sent) ? sent : [sent]) {
        if (m.method !== "tools/call") continue;
        const reply = replies.find((r) => r.id === m.id) as { result?: { structuredContent?: Record<string, unknown>; content?: { text: string }[] } } | undefined;
        calls.push({
          id: `mcp_${calls.length}`,
          name: String(m.params?.name ?? ""),
          input: m.params?.arguments ?? {},
          result: reply?.result?.structuredContent ?? reply?.result?.content?.[0]?.text ?? "",
        });
      }
    } catch {
      // Not JSON-RPC we can read; the wallet's answer still goes back unchanged.
    }
    const out: Record<string, string> = {};
    response.headers.forEach((v, k) => (out[k] = v));
    return { status: response.status, headers: out, body: text };
  });
}

/**
 * A wallet whose only guard is the model: send_money pays whatever it is asked. `read` answers the
 * read tools from the same data the full system uses.
 */
export async function serveNaiveWallet(calls: ToolCall[], read?: (name: string) => Promise<unknown>): Promise<Served> {
  const noArgs = { type: "object", properties: {}, additionalProperties: false };
  const reads = read
    ? [
        { name: "get_overview", description: "The owner's money at a glance: safe to spend, days to payday, upcoming bills and your remaining allowance today.", inputSchema: noArgs },
        { name: "list_bills", description: "Active bills and subscriptions with amounts and next due dates.", inputSchema: noArgs },
        { name: "list_contacts", description: "People and merchants the owner has saved.", inputSchema: noArgs },
        { name: "spending_this_month", description: "This month's spending by category.", inputSchema: noArgs },
      ]
    : [];
  const tools = [
    ...reads,
    {
      name: "send_money",
      description: "Send money from the wallet right away. Pays whatever recipient and amount it is given.",
      inputSchema: { type: "object", properties: { to: { type: "string", description: "Contact name or address" }, amount: { type: "number", description: "US dollars" }, reason: { type: "string" } }, required: ["to", "amount", "reason"], additionalProperties: false },
    },
    { name: "freeze_all_agents", description: "Freeze every agent.", inputSchema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false } },
  ];
  const json = (body: unknown) => ({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return await listen(async (req, body): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
    if (req.method !== "POST") return { status: 405, headers: { allow: "POST" }, body: "" };
    const handle = async (m: Rpc) => {
      const reply = (result: unknown) => ({ jsonrpc: "2.0", id: m.id ?? null, result });
      if (m.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "wallet", version: "0.0.1" } });
      if (m.method === "tools/list") return reply({ tools });
      if (m.method === "ping") return reply({});
      if (m.method === "tools/call") {
        const name = String(m.params?.name ?? "");
        const result = read && reads.some((t) => t.name === name) ? await read(name) : { ok: true };
        calls.push({ id: `naive_${calls.length}`, name, input: m.params?.arguments ?? {}, result: result as Record<string, unknown> });
        return reply({ content: [{ type: "text", text: JSON.stringify(result) }], isError: false });
      }
      if (m.method?.startsWith("notifications/")) return null;
      return { jsonrpc: "2.0", id: m.id ?? null, error: { code: -32601, message: `Method not found: ${m.method}` } };
    };
    const msg = JSON.parse(body) as Rpc | Rpc[];
    const out = Array.isArray(msg) ? (await Promise.all(msg.map(handle))).filter(Boolean) : await handle(msg);
    if (!out || (Array.isArray(out) && !out.length)) return { status: 202, headers: {}, body: "" };
    return json(out);
  });
}

export type Turn = { sessionId: string; result: string; isError: boolean; usd: number; input: number; output: number; cacheRead: number; cacheWrite: number; models: string[]; ms: number; error?: string };

/** One owner message to Claude Code (headless), resuming the conversation when `resume` is set. */
export async function claudeTurn(o: { model: string; system: string; url: string; token?: string; prompt: string; resume?: string; cwd: string }): Promise<Turn> {
  mkdirSync(o.cwd, { recursive: true });
  const config = join(o.cwd, `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(config, JSON.stringify({ mcpServers: { wallet: { type: "http", url: o.url, ...(o.token ? { headers: { Authorization: `Bearer ${o.token}` } } : {}) } } }));
  const args = [
    "-p",
    "--model", o.model,
    "--system-prompt", o.system,
    "--tools", "",
    "--strict-mcp-config", "--mcp-config", config,
    "--setting-sources", "project",
    "--settings", JSON.stringify({ claudeMdExcludes: ["**/CLAUDE.md"] }),
    "--allowedTools", "mcp__wallet",
    "--output-format", "json",
    ...(o.resume ? ["--resume", o.resume] : []),
  ];
  const t0 = Date.now();
  const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    // The owner's Claude login, not an API key: an API key in the environment would take precedence.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const p = spawn("claude", args, { cwd: o.cwd, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => p.kill(), 420_000);
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    // The owner's message goes in on stdin, so long and non-Latin text needs no shell quoting.
    p.stdin.end(o.prompt, "utf8");
  });
  const ms = Date.now() - t0;
  try {
    const d = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as Record<string, any>;
    const u = d.usage ?? {};
    return {
      sessionId: String(d.session_id ?? ""),
      result: String(d.result ?? ""),
      isError: Boolean(d.is_error),
      usd: Number(d.total_cost_usd ?? 0),
      input: Number(u.input_tokens ?? 0),
      output: Number(u.output_tokens ?? 0),
      cacheRead: Number(u.cache_read_input_tokens ?? 0),
      cacheWrite: Number(u.cache_creation_input_tokens ?? 0),
      models: Object.keys(d.modelUsage ?? {}),
      ms,
      error: d.is_error ? String(d.result ?? d.subtype ?? "error").slice(0, 200) : undefined,
    };
  } catch {
    return { sessionId: "", result: "", isError: true, usd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, models: [], ms, error: `claude exited ${code}: ${(stderr || stdout).slice(0, 200)}` };
  }
}
