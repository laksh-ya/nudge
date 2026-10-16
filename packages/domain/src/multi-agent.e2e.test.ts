/**
 * Issue #15: assistants from different vendors share one wallet. Claude Code (Anthropic) and Hermes
 * Agent (Nous Research, here running Zhipu AI's GLM-5.3 via NVIDIA NIM) connect over MCP to the same
 * sandbox, each with its own key and its own limits, and pay from one PolicyVault on Base Sepolia.
 * The wallet-wide ceiling covers all of them together.
 *
 *   E2E_CONVEX_URL=… E2E_DEMO_JWK=… MULTI_AGENT=1 pnpm --filter @agent-wallet/domain exec vitest run multi-agent
 *
 * Needs the `claude` and `hermes` CLIs. Hermes's config.yaml is backed up and restored; the sandbox
 * keys exist only for this run. A fresh demo sandbox each time, never the judge account.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEventLogs, type Address } from "viem";
import { afterAll, describe, expect, it } from "vitest";
import { policyVaultAbi } from "./abi";
import { EXPLORER } from "./vault";
import { CONVEX, SITE, enabled, harness, pub, until } from "./e2e-harness";

const run = enabled && process.env.MULTI_AGENT ? describe : describe.skip;
const h = harness("multi-agent");
const HERMES_CONFIG = process.env.HERMES_CONFIG ?? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "hermes", "config.yaml");
const tmp = mkdtempSync(join(tmpdir(), "multi-agent-"));
const transcripts: Record<string, string> = {};
const rows: string[] = [];

function sh(cmd: string, args: string[], input?: string, env: Record<string, string | undefined> = {}) {
  return new Promise<{ code: number; out: string; err: string }>((done) => {
    const p = spawn(cmd, args, { shell: process.platform === "win32", env: { ...process.env, ...env } });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    if (input !== undefined) p.stdin.end(input);
    p.on("close", (code) => done({ code: code ?? 1, out, err }));
  });
}

const quote = (s: string) => (process.platform === "win32" ? `"${s.replace(/"/g, '\\"')}"` : `'${s.replace(/'/g, "'\\''")}'`);

async function claude(key: string, prompt: string) {
  const config = join(tmp, "claude-mcp.json");
  writeFileSync(config, JSON.stringify({ mcpServers: { wallet: { type: "http", url: `${SITE}/mcp`, headers: { Authorization: `Bearer ${key}` } } } }), { mode: 0o600 });
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const r = await sh("claude", ["-p", "--model", "sonnet", "--tools", process.platform === "win32" ? '""' : "''", "--strict-mcp-config", "--mcp-config", quote(config), "--allowedTools", "mcp__wallet", "--setting-sources", "project", "--output-format", "json"], prompt, env);
  rmSync(config, { force: true });
  try {
    return String(JSON.parse(r.out).result ?? r.out);
  } catch {
    return `${r.out}\n${r.err}`.slice(0, 600);
  }
}

async function hermes(prompt: string) {
  // Hermes filters MCP servers with -t too, so it keeps its default tools in its normal approval mode;
  // the model is GLM-5.3 (Zhipu AI) on NVIDIA NIM, whose tool calls Hermes executes reliably.
  const r = await sh("hermes", ["chat", "-q", quote(prompt), "--oneshot", "-Q", "--max-turns", "6", "-m", process.env.HERMES_MODEL ?? "z-ai/glm-5.3"]);
  return `${r.out}`.trim().slice(-800) || r.err.slice(-400);
}

run(`two vendors' assistants, one wallet (${CONVEX})`, () => {
  let vault: Address;
  let fromBlock: bigint;
  let backup: string | null = null;
  const keys: Record<string, string> = {};
  const addr: Record<string, Address> = {};

  it("sets up a live vault, adds Hermes with its own limits, and gives each assistant a key", async () => {
    const v = await h.liveVault();
    vault = v.vault;
    fromBlock = await pub.getBlockNumber();
    const hermesId = await h.convex<string>("mutation", "onboarding:addAssistant", { provider: "hermes" });
    // As in the app: connect first (the key makes it active), then set what it may do; the vault key
    // and its on-chain grant are created at that point.
    keys.hermes = await h.convex<string>("mutation", "gateway:issueToken", { agentId: hermesId });
    const already = (await h.convex<{ provider: string; onchain?: boolean }[]>("query", "agents:list")).find((a) => a.provider === "hermes")?.onchain;
    if (!already) {
    const token = await h.convex<string | null>("mutation", "gateway:updateGrant", { agentId: hermesId, scopes: ["read", "prepare", "spend", "request"], dailyCapMinor: 1500, perPaymentMinor: 1000, hidesBalances: true, days: 7 });
    // A new assistant's vault key is made in the background, then its grant arrives as an approval card
    // for the owner ("Let Hermes pay within limits"). The passkey signs it; the vault waits its change delay.
    const card =
      token ??
      (
        await until(
          "Hermes's approval card",
          async () =>
            (await h.convex<{ title: string; state: string; approvalToken?: string }[]>("query", "tasks:list")).find(
              (t) => t.title.includes("Hermes") && t.state === "awaiting_approval" && t.approvalToken,
            ),
          180_000,
        )
      ).approvalToken!;
    await h.approve(card, ["queued", "confirmed", "failed"]);
    }
    const agents = await until(
      "Hermes registered in the vault",
      async () => {
        const list = await h.convex<{ _id: string; provider: string; chainAddress?: Address; onchain?: boolean; status: string }[]>("query", "agents:list");
        const hm = list.find((a) => a.provider === "hermes");
        // Registered once the vault applied the grant; the key (issued below) makes it active.
        return hm?.onchain ? list : null;
      },
      300_000,
    );
    console.log("agents:", agents.map((a) => `${a.provider}:${a.status}:onchain=${a.onchain ?? false}`).join(", "));
    for (const p of ["claude", "hermes"]) {
      const a = agents.find((x) => x.provider === p)!;
      // A frozen assistant's key is refused by the gateway; unfreezing on a live vault takes the passkey.
      if (a.status === "frozen") {
        const t = await h.convex<string | null>("mutation", "agents:setStatus", { agentId: a._id, status: "active" });
        if (t) await h.approve(t, ["queued", "confirmed", "failed"]);
        await until(`${p} unfrozen`, async () => (await h.convex<{ provider: string; status: string }[]>("query", "agents:list")).find((x) => x.provider === p)?.status !== "frozen" || null, 300_000);
      }
      if (!keys[p]) keys[p] = await h.convex<string>("mutation", "gateway:issueToken", { agentId: a._id });
      addr[p] = a.chainAddress!;
    }
    addr.own = agents.find((x) => x.provider === "own")!.chainAddress!;
    if (existsSync(HERMES_CONFIG)) {
      backup = `${HERMES_CONFIG}.multi-agent-backup`;
      copyFileSync(HERMES_CONFIG, backup);
    }
    const base = backup ? readFileSync(backup, "utf8") : "";
    writeFileSync(HERMES_CONFIG, `${base.replace(/\n?mcp_servers:[\s\S]*$/m, "")}\nmcp_servers:\n  wallet:\n    url: ${SITE}/mcp\n    headers:\n      Authorization: Bearer ${keys.hermes}\n`, { mode: 0o600 });
    expect(addr.claude).not.toBe(addr.hermes);
  }, 900_000);

  it("both assistants pay from the same vault at the same moment, each with its own key", async () => {
    const ask = (who: string, amount: number) => `You manage a test wallet through the wallet tools. Pay the saved contact "Blue Tokai" $${amount} for ${who === "claude" ? "coffee beans" : "a tea order"}: list the contacts, propose the payment, then check its status once and report the outcome in one sentence.`;
    const [c, hm] = await Promise.all([claude(keys.claude!, ask("claude", 6)), hermes(ask("hermes", 7))]);
    transcripts["Claude Code (Anthropic, Sonnet)"] = c;
    transcripts["Hermes Agent (Nous Research, GLM-5.3 by Zhipu AI via NVIDIA)"] = hm;
    console.log("CLAUDE:", c.slice(0, 300));
    console.log("HERMES:", hm.slice(0, 300));
  }, 600_000);

  it("the vault saw two different agent keys pay, and the shared ceiling covers both", async () => {
    // Held payments (above $5) leave after the 2-minute window.
    await new Promise((r) => setTimeout(r, 150_000));
    const head = await pub.getBlockNumber();
    const events: ReturnType<typeof parseEventLogs<typeof policyVaultAbi>> = [];
    for (let b = fromBlock; b <= head; b += 199n) {
      const logs = await pub.getLogs({ address: vault, fromBlock: b, toBlock: b + 198n > head ? head : b + 198n });
      events.push(...parseEventLogs({ abi: policyVaultAbi, logs }));
    }
    const byAgent = (a: Address) => events.filter((e) => ["PaymentExecuted", "PaymentHeld"].includes(e.eventName) && String((e.args as { agent: string }).agent).toLowerCase() === a.toLowerCase());
    for (const [who, a] of Object.entries({ "Claude Code": addr.claude!, Hermes: addr.hermes! })) {
      for (const e of byAgent(a)) rows.push(`| ${who} | ${e.eventName} $${Number((e.args as { amount: bigint }).amount) / 1e6} | \`${a.slice(0, 10)}…\` | [\`${e.transactionHash.slice(0, 10)}…\`](${EXPLORER}/tx/${e.transactionHash}) |`);
    }
    for (const e of events.filter((x) => x.eventName === "PaymentReleased")) rows.push(`| relayer | PaymentReleased $${Number((e.args as { amount: bigint }).amount) / 1e6} | – | [\`${e.transactionHash.slice(0, 10)}…\`](${EXPLORER}/tx/${e.transactionHash}) |`);
    const spent = await pub.readContract({ address: vault, abi: policyVaultAbi, functionName: "vaultSpentToday" });
    rows.push(`| vault | spent today, all agents together | – | $${Number(spent) / 1e6} of the $40 ceiling |`);
    console.log(rows.join("\n"));
    expect(byAgent(addr.claude!).length).toBeGreaterThan(0);
    expect(byAgent(addr.hermes!).length).toBeGreaterThan(0);
  }, 600_000);

  afterAll(() => {
    if (backup) {
      copyFileSync(backup, HERMES_CONFIG);
      rmSync(backup, { force: true });
    }
    rmSync(tmp, { recursive: true, force: true });
    if (rows.length) {
      writeFileSync(
        resolve(__dirname, "../../../evals/results/multi-agent.md"),
        `# Two vendors' assistants, one wallet\n\n${new Date().toISOString().slice(0, 16)} UTC · vault [\`${vault}\`](${EXPLORER}/address/${vault}) · Base Sepolia\n\n| Who | Event | Agent key | Transaction |\n|---|---|---|---|\n${rows.join("\n")}\n\n## What each assistant said\n\n${Object.entries(transcripts).map(([k, v]) => `**${k}:** ${v.replace(/\s+/g, " ").slice(0, 500)}`).join("\n\n")}\n`,
      );
    }
  });
});
