/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { MCP_TOOLS, REASON_CODES, invalidArgs, toolsFor } from "./lib/mcp";

/**
 * The MCP gateway as an outside assistant sees it: tools/list filtered by the key's permissions,
 * refusals in words a model can pass on, argument checks, and the HTTP surface (401 discovery,
 * CORS, rate-limit headers).
 */
const sent: unknown[] = [];
vi.mock("./lib/relayer", () => {
  const pool = { enqueueAction: vi.fn(async (_c: unknown, _f: unknown, args: unknown) => (sent.push(args), "queued")) };
  return { relayer: pool, agentPool: pool, lanePool: () => pool, laneOf: () => 0, laneCount: () => 1, MAX_LANES: 4 };
});
const modules = import.meta.glob(["./**/*.ts", "./**/*.js", "!./**/*.test.ts"]);

const NOW = Date.UTC(2026, 9, 17, 6);
const DAY = 86_400_000;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  sent.length = 0;
});
afterEach(() => vi.useRealTimers());

type Scope = "read" | "prepare" | "spend" | "request";
const FULL: Scope[] = ["read", "prepare", "spend", "request"];

async function world(scopes: Scope[], name = "Hermes") {
  const t = convexTest(schema, modules);
  const owner = t.withIdentity({ subject: "alice", issuer: "https://test.local", tokenIdentifier: "https://test.local|alice" });
  const alice = (await owner.mutation(api.users.ensure, {}))!;
  const ids = await t.run(async (ctx) => {
    const agent = await ctx.db.insert("agents", {
      userId: alice, name, provider: "hermes", status: "active", scopes,
      dailyCapMinor: 2500, perPaymentMinor: 1500, spentTodayMinor: 400, hidesBalances: false, connectedAt: NOW, expiresAt: NOW + 30 * DAY,
    });
    const payee = await ctx.db.insert("payees", { userId: alice, name: "Blue Tokai", handle: "shop", kind: "merchant", trusted: true });
    await ctx.db.insert("wallets", {
      userId: alice, address: "", chain: "base-sepolia", asset: "USDC", balanceMinor: 25_000,
      protectedMinor: 5000, dailyCeilingMinor: 10_000, perPaymentMinor: 1500, frozen: false,
    });
    return { agent, payee };
  });
  const key = await t.mutation(internal.gateway.issueTokenAsOperator, { agentId: ids.agent });
  const rpc = async (method: string, params?: object, headers: Record<string, string> = { authorization: `Bearer ${key}` }) => {
    const res = await t.fetch("/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return { res, body: res.status === 202 ? null : ((await res.json()) as { result?: any; error?: { code: number; message: string } }) };
  };
  const call = async (name: string, args: object = {}) => (await rpc("tools/call", { name, arguments: args })).body!.result as { isError: boolean; content: { text: string }[]; structuredContent?: any };
  const tasks = () => t.run((ctx) => ctx.db.query("tasks").collect());
  return { t, alice, key, rpc, call, tasks, ...ids };
}

const names = (tools: { name: string }[]) => tools.map((x) => x.name).sort();

describe("tools/list: every connected assistant sees every tool", () => {
  it("a key with no spending limit still lists every tool, including payments, plans and commerce", async () => {
    const w = await world(["read"]);
    const listed = names((await w.rpc("tools/list")).body!.result.tools);
    expect(listed).toEqual(names(MCP_TOOLS));
    for (const t of ["propose_payment", "list_pending", "get_plan", "set_reminder", "add_contact", "request_limits", "pay_x402", "watch_price", "get_card"]) expect(listed).toContain(t);
  });

  it("every listed tool has a title, read/write annotations, a closed schema and no internal fields", async () => {
    const w = await world(FULL);
    for (const tool of (await w.rpc("tools/list")).body!.result.tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.annotations).toHaveProperty("readOnlyHint");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool).not.toHaveProperty("requires");
    }
    const pay = MCP_TOOLS.find((x) => x.name === "propose_payment")!;
    for (const word of ["dollars", "submitted", "held", "confirmed", "needs_approval", "refused", "duplicate", "approvalUrl", "passkey"]) expect(pay.description).toContain(word);
  });

  it("every tool in the catalog is wired to the gateway", async () => {
    const w = await world(FULL);
    for (const tool of MCP_TOOLS) {
      const args = Object.fromEntries((tool.inputSchema.required ?? []).map((k) => [k, tool.inputSchema.properties[k]!.type === "number" ? 1 : "x"]));
      const out = await w.call(tool.name, args);
      expect(out, tool.name).toBeDefined();
      if (out.isError) expect(out.content[0]!.text).not.toMatch(/Unknown tool/);
    }
  });
});

describe("a key without its own limit asks instead of being refused", () => {
  it("propose_payment returns an approval link for the owner, and nothing is paid", async () => {
    const w = await world(["read"]);
    const out = await w.call("propose_payment", { contactId: w.payee, amount: 3, reason: "coffee" });
    expect(out.isError).toBe(false);
    expect(out.structuredContent).toMatchObject({ outcome: "needs_approval" });
    expect(out.structuredContent.approvalUrl).toMatch(/^https:\/\/nudge-approve\.vercel\.app\/a\/.{16,}$/);
    const [task] = await w.tasks();
    expect(task!.state).toBe("awaiting_approval");
    expect(sent).toHaveLength(0);
  });

  it("it can pay someone new by address: the owner approves that with the passkey too", async () => {
    const w = await world(FULL);
    const out = await w.call("propose_payment", { toAddress: "0x00000000000000000000000000000000000000c3", name: "New Shop", amount: 2, reason: "a test" });
    expect(out.structuredContent).toMatchObject({ outcome: "needs_approval" });
    expect(out.structuredContent.reason).toMatch(/New Shop is a new payee, not a trusted contact/);
    const bad = await w.call("propose_payment", { toAddress: "0x123", amount: 2, reason: "x" });
    expect(bad.structuredContent).toMatchObject({ outcome: "refused", code: "2014" });
  });

  it("status and overview work for it, with balances", async () => {
    const w = await world(["read"]);
    const o = await w.call("get_overview");
    expect(o.isError).toBe(false);
    expect(o.structuredContent.nudgeWallet).toMatch(/\$250\.00/);
  });
});

describe("errors a model can act on", () => {
  it("get_my_limits explains what the key may do, in dollars", async () => {
    const ro = await world(["read"]);
    const mine = (await ro.call("get_my_limits")).structuredContent;
    expect(mine).toMatchObject({ assistant: "Hermes", payOnYourOwn: false, perPaymentLimit: { amountMinor: 0, currency: "USD" } });
    expect(mine.tools).toContain("propose_payment");
    expect(mine.note).toMatch(/approval link/);
    const full = await world(FULL);
    const limits = (await full.call("get_my_limits")).structuredContent;
    expect(limits).toMatchObject({ payOnYourOwn: true, perPaymentLimit: { amountMinor: 1500, display: "$15.00" }, dailyLimit: { amountMinor: 2500 }, leftToday: { amountMinor: 2100 } });
    expect(limits.note).toMatch(/\$15\.00 a payment and \$25\.00 a day on your own/);
  });

  it("an amount sent as a string is refused, not coerced, and nothing is paid", async () => {
    const w = await world(FULL);
    const out = await w.call("propose_payment", { contactId: w.payee, amount: "5", reason: "coffee" });
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/"amount" must be a number, not "5"/);
    expect(await w.tasks()).toHaveLength(0);
  });

  it("missing and unexpected arguments are named", async () => {
    const w = await world(FULL);
    expect((await w.call("propose_payment", { contactId: w.payee, reason: "x" })).content[0]!.text).toMatch(/needs "amount"/);
    expect((await w.call("propose_payment", { contactId: w.payee, amount: 3, reason: "x", to: "0xabc" })).content[0]!.text).toMatch(/no argument "to"/);
  });

  it("a valid payment inside the limits still goes through", async () => {
    const w = await world(FULL);
    const out = await w.call("propose_payment", { contactId: w.payee, amount: 3, reason: "coffee", requestId: "inv-1" });
    expect(out.isError).toBe(false);
    expect(out.structuredContent.outcome).toBe("submitted");
  });

  it("an unknown tool is a JSON-RPC invalid-params error that points at tools/list", async () => {
    const w = await world(FULL);
    const { body } = await w.rpc("tools/call", { name: "transfer_all", arguments: {} });
    expect(body!.error).toEqual({ code: -32602, message: 'Unknown tool "transfer_all". Call tools/list for the tools this key can use.' });
  });

  it("a frozen or expired assistant hears what happened and who can fix it", async () => {
    const w = await world(FULL);
    await w.t.run((ctx) => ctx.db.patch(w.agent, { expiresAt: NOW - 1 }));
    const expired = await w.rpc("tools/list");
    expect(expired.res.status).toBe(401);
    expect(expired.body!.error!.message).toBe("Hermes's access has expired. Ask the owner to extend it in Agents → Hermes → Limits.");
    await w.t.run((ctx) => ctx.db.patch(w.agent, { status: "frozen", expiresAt: NOW + DAY }));
    const { res, body } = await w.rpc("tools/list");
    expect(res.status).toBe(403);
    expect(body!.error!.message).toMatch(/Hermes is frozen by its owner/);
  });

  it("the reason-code table covers every code the gateway returns", async () => {
    const src = (await import("./gateway.ts?raw")).default as string;
    const used = new Set([...src.matchAll(/code: "(\d{4})"/g)].map((m) => m[1]));
    const documented = new Set(REASON_CODES.map((c) => c.code));
    for (const code of used) expect(documented, code).toContain(code);
  });
});

describe("HTTP surface", () => {
  it("no key: 401 with a WWW-Authenticate pointer to the protected-resource metadata", async () => {
    const w = await world(["read"]);
    const { res, body } = await w.rpc("tools/list", undefined, {});
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer resource_metadata="https?:\/\/[^"]+\/\.well-known\/oauth-protected-resource"$/);
    expect(body!.error!.message).toMatch(/Missing access key/);
  });

  it("a malformed or unknown key gets the same plain answer", async () => {
    const w = await world(["read"]);
    for (const authorization of ["Bearer short", "Bearer aw_" + "x".repeat(30), "Basic abc"]) {
      const { res, body } = await w.rpc("tools/list", undefined, { authorization });
      expect(res.status).toBe(401);
      expect(body!.error!.message).toBe("Invalid or revoked access key. Ask the owner for a new key from the Agents screen.");
    }
  });

  it("serves protected-resource metadata with bearer-in-header and no authorization server yet", async () => {
    const w = await world(["read"]);
    const res = await w.t.fetch("/.well-known/oauth-protected-resource", { method: "GET" });
    expect(res.status).toBe(200);
    const meta = await res.json();
    expect(meta.resource).toMatch(/\/mcp$/);
    expect(meta.bearer_methods_supported).toEqual(["header"]);
    expect(meta).not.toHaveProperty("authorization_servers");
  });

  it("answers CORS preflight for browser clients", async () => {
    const w = await world(["read"]);
    const res = await w.t.fetch("/mcp", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toMatch(/Authorization/);
    expect(res.headers.get("access-control-allow-headers")).toMatch(/Mcp-Protocol-Version/);
  });

  it("rate-limited calls say when to come back", async () => {
    const w = await world(["read"]);
    await w.t.mutation(internal.gateway.allow, { agentId: w.agent, calls: 60 });
    const { res } = await w.rpc("tools/list");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });
});

describe("argument checks (pure)", () => {
  const pay = MCP_TOOLS.find((x) => x.name === "propose_payment")!;
  it("accepts a well-formed call and rejects non-objects", () => {
    expect(invalidArgs(pay, { contactId: "c", amount: 12.5, reason: "r" })).toBeNull();
    expect(invalidArgs(pay, [1])).toMatch(/JSON object/);
    expect(invalidArgs(pay, { contactId: "c", amount: Number.NaN, reason: "r" })).toMatch(/must be a number/);
  });
  it("toolsFor lists every tool, without internal fields", () => {
    expect(toolsFor(["read"]).map((x) => x.name)).toEqual(MCP_TOOLS.map((x) => x.name));
    expect(toolsFor(["read"])[0]).not.toHaveProperty("group");
  });
});


describe("unusable keys and malformed MCP requests", () => {
  it("revoking an assistant rejects its key before initialize or tools/list", async () => {
    const w = await world(FULL);
    await w.t.run((ctx) => ctx.db.patch(w.agent, { status: "revoked" }));
    for (const method of ["initialize", "tools/list", "tools/call"]) {
      expect((await w.rpc(method)).res.status).toBe(401);
    }
    expect(await w.tasks()).toHaveLength(0);
  });

  it("invalid JSON-RPC envelopes return an error rather than throwing or paying", async () => {
    const w = await world(FULL);
    const pay = { method: "tools/call", params: { name: "propose_payment", arguments: { contactId: w.payee, amount: 3, reason: "coffee" } } };
    for (const body of [null, 1, "tools/list", {}, { jsonrpc: "1.0", id: 1, ...pay }, { jsonrpc: "2.0", ...pay }, { jsonrpc: "2.0", id: 1, method: "tools/call", params: [] }, { jsonrpc: "2.0", id: {}, ...pay }]) {
      const res = await w.t.fetch("/mcp", { method: "POST", headers: { authorization: `Bearer ${w.key}` }, body: JSON.stringify(body) });
      expect(res.status).toBe(200);
      expect((await res.json()).error.code).toBe(-32600);
    }
    expect(await w.tasks()).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("one invalid batch entry does not prevent a valid read response", async () => {
    const w = await world(["read"]);
    const res = await w.t.fetch("/mcp", { method: "POST", headers: { authorization: `Bearer ${w.key}` }, body: JSON.stringify([null, { jsonrpc: "2.0", id: 2, method: "tools/list" }]) });
    const out = await res.json();
    expect(out[0].error.code).toBe(-32600);
    expect(out[1].id).toBe(2);
    expect(out[1].result.tools.length).toBeGreaterThan(0);
  });

  it("does not advertise an optional-id payment as idempotent", () => {
    expect(MCP_TOOLS.find((t) => t.name === "propose_payment")!.annotations.idempotentHint).toBe(false);
  });
});

describe("settings an assistant can change over MCP (#119)", () => {
  it("change_rules: stricter applies at once on a simulated wallet; looser needs the owner's yes", async () => {
    const w = await world(FULL);
    const tighter = await w.call("change_rules", { dailyCeiling: 50, newContactWaitMinutes: 2880, why: "be safer" });
    expect(tighter.structuredContent).toMatchObject({ outcome: "applied" });
    const wallet = await w.t.run(async (ctx) => (await ctx.db.query("wallets").collect())[0]!);
    expect(wallet).toMatchObject({ dailyCeilingMinor: 5000, rules: { contactDelay: 172_800 } });

    const looser = await w.call("change_rules", { dailyCeiling: 200, why: "big shopping day" });
    expect(looser.structuredContent).toMatchObject({ outcome: "needs_approval" });
    expect((await w.t.run(async (ctx) => (await ctx.db.query("wallets").collect())[0]!)).dailyCeilingMinor).toBe(5000);
    // The owner's yes in the app applies it.
    const token = looser.structuredContent.approvalUrl.split("/a/")[1];
    const owner = w.t.withIdentity({ subject: "alice", issuer: "https://test.local", tokenIdentifier: "https://test.local|alice" });
    expect(await owner.mutation(api.approvals.decide, { token, approve: true })).toBe("confirmed");
    expect((await w.t.run(async (ctx) => (await ctx.db.query("wallets").collect())[0]!)).dailyCeilingMinor).toBe(20_000);
  });

  it("update_reminder_settings, update_bill and add_goal apply without money moving", async () => {
    const w = await world(FULL);
    const r = await w.call("update_reminder_settings", { leadDays: 3, quietFrom: "22:30", quietTo: "07:00" });
    expect(r.structuredContent.message).toMatch(/3 days before, in the app, quiet 22:30–07:00/);
    expect((await w.call("update_reminder_settings", { quietFrom: "08:00", quietTo: "08:00" })).isError).toBe(true);

    await w.call("add_bill", { name: "Rent", amount: 18000, due: "2026-11-01" });
    const bills = (await w.call("list_bills")).structuredContent;
    const rent = (Array.isArray(bills) ? bills : bills.items ?? bills.bills).find((b: { name: string }) => b.name === "Rent");
    expect(rent.billId).toBeTruthy();
    const up = await w.call("update_bill", { billId: rent.billId, amount: 19000, status: "pause" });
    expect(up.structuredContent).toMatchObject({ outcome: "applied" });
    const row = await w.t.run(async (ctx) => (await ctx.db.query("obligations").collect()).find((o) => o.name === "Rent")!);
    expect(row).toMatchObject({ amountMinor: 1_900_000, previousAmountMinor: 1_800_000, status: "paused" });

    const g = await w.call("add_goal", { name: "Goa trip", target: 30000, by: "2027-03-01" });
    expect(g.structuredContent.message).toMatch(/Goa trip/);
    expect(await w.tasks()).toHaveLength(0);
  });
});

describe("top up the wallet from a connected source (#116)", () => {
  it("moves money from a bank account into the simulated wallet, converted, within the caps", async () => {
    const w = await world(FULL);
    const owner = w.t.withIdentity({ subject: "alice", issuer: "https://test.local", tokenIdentifier: "https://test.local|alice" });
    const bank = await w.t.run((ctx) =>
      ctx.db.insert("accounts", { userId: w.alice, kind: "bank", name: "HDFC Savings", institution: "HDFC", currency: "INR", balanceMinor: 5_000_000, syncedAt: NOW, source: "sandbox", can: ["read"] }),
    );
    const r = await owner.mutation(api.wallet.topUp, { accountId: bank, amount: 20 });
    expect(r).toMatchObject({ amountMinor: 2000, currency: "INR" });
    const after = await w.t.run(async (ctx) => ({ wallet: (await ctx.db.query("wallets").collect())[0]!, bank: (await ctx.db.get(bank))! }));
    expect(after.wallet.balanceMinor).toBe(25_000 + 2000);
    expect(after.bank.balanceMinor).toBe(5_000_000 - r.costMinor);
    expect(r.costMinor).toBeGreaterThan(2000); // rupees per dollar
    await expect(owner.mutation(api.wallet.topUp, { accountId: bank, amount: 600 })).rejects.toThrow(/\$1 and \$500/);
    const poor = await w.t.run((ctx) =>
      ctx.db.insert("accounts", { userId: w.alice, kind: "bank", name: "Empty", institution: "X", currency: "USD", balanceMinor: 100, syncedAt: NOW, source: "manual", can: ["read"] }),
    );
    await expect(owner.mutation(api.wallet.topUp, { accountId: poor, amount: 5 })).rejects.toThrow(/not enough/);
  });
});
