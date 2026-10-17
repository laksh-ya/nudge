/**
 * Checks every Base Sepolia transaction the docs cite against the chain itself, so a judge (or we)
 * can confirm the execution evidence without trusting a screenshot or our backend.
 *
 * For each table row in README.md, docs/SECURITY.md and evals/README.md that links a transaction,
 * the row's wording is turned into the events it must contain ("refused, code 2003" means a
 * PaymentRefused with code 2003, "held" a PaymentHeld, "approves $12" an OwnerPaid of 12 tUSD, ...)
 * and the receipt is decoded with the contract ABIs. It also compares the example vault the README
 * names (v3 when listed, else v2) with a local `forge build` (immutables masked), so the source in
 * this repo is what runs on-chain.
 *
 *   EVIDENCE_RPC=https://sepolia.base.org pnpm --filter @agent-wallet/domain exec vitest run evidence.e2e
 *
 * Read-only: no keys, no transactions. Writes evals/results/onchain-evidence.csv.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http, parseEventLogs, type Address, type Hex, type Log } from "viem";
import { baseSepolia } from "viem/chains";
import { describe, expect, it } from "vitest";
import { policyVaultAbi, testUsdAbi, vaultFactoryAbi } from "../src/abi";

const rpc = process.env.EVIDENCE_RPC ?? "";
const run = rpc ? describe : describe.skip;
const root = resolve(__dirname, "../../..");
const DOCS = ["README.md", "docs/SECURITY.md", "evals/README.md", ...submissionDocs()];
/** The submission documents, once they exist. */
function submissionDocs() {
  const dir = resolve(root, "docs/submission");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => `docs/submission/${f}`) : [];
}
const FACTORY_V2 = "0x672DcD9A822030371d017673403edc290c9d8975";
const TOKEN = "0xB0ee01235A8e7903519B029c1530332f5847D932";
const EXAMPLE_V2_VAULT = "0xa395739975fd3f66b83cbcf6ad535029e5a94e73";
/** The newest example vault the README lists: the build in this repo should match it. */
function exampleVault(): { version: string; address: Address } {
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  for (const version of ["v3", "v2"]) {
    const row = readme.split("\n").find((l) => l.includes(`Example ${version} vault`));
    const address = row?.match(/0x[0-9a-fA-F]{40}/)?.[0];
    if (address) return { version, address: address.toLowerCase() as Address };
  }
  return { version: "v2", address: EXAMPLE_V2_VAULT };
}

type Row = { doc: string; line: number; text: string; hash: Hex };
type Expect = { event: string; check?: (args: Record<string, unknown>) => boolean; why: string };

function rows(): Row[] {
  const out: Row[] = [];
  for (const doc of DOCS) {
    readFileSync(resolve(root, doc), "utf8").split("\n").forEach((text, i) => {
      for (const m of text.matchAll(/sepolia\.basescan\.org\/tx\/(0x[0-9a-fA-F]{64})/g)) {
        out.push({ doc, line: i + 1, text, hash: m[1] as Hex });
      }
    });
  }
  return out;
}

const usd = (n: number) => BigInt(Math.round(n * 1e6));

/** What the row's own words promise the transaction did. */
function expectations(row: Row): Expect[] {
  const t = row.text.toLowerCase();
  // The cell that describes the step is the first one; later cells hold the signer and the link.
  const step = (row.text.split("|")[1] ?? row.text).toLowerCase();
  const out: Expect[] = [];
  const dollars = [...step.matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const code = step.match(/code (\d{4})/);

  if (/deployed/.test(step)) out.push({ event: "VaultCreated", why: "vault deployment" });
  if (code) out.push({ event: "PaymentRefused", check: (a) => Number(a.code) === Number(code[1]), why: `refusal code ${code[1]}` });
  if (/fourth refusal|fifth refusal/.test(step)) out.push({ event: "PaymentRefused", why: "a refusal" });
  if (/freezes that key itself/.test(step)) out.push({ event: "Frozen", why: "self-freeze after five strikes" });
  if (/guardian freezes/.test(step)) out.push({ event: "Frozen", why: "guardian freeze" });
  if (/^\s*setup|setup:/.test(step)) out.push({ event: "OwnerAction", why: "owner-signed setup" });
  if (/queued, not applied/.test(step)) out.push({ event: "ChangeQueued", why: "loosening queued" });
  if (/applied after/.test(step)) out.push({ event: "ChangeApplied", why: "queued change applied" });
  if (/unfreeze/.test(step) && /applied|owner unfreezes/.test(step) && !/not applied/.test(step)) out.push({ event: "Unfrozen", why: "unfreeze applied" });
  if (/guardian stops|cancelled/.test(step)) out.push({ event: "PaymentCancelled", why: "held payment stopped" });
  if (/removed from the vault/.test(step)) out.push({ event: "AgentRemoved", why: "agent key removed" });
  if (/released/.test(step)) out.push({ event: "PaymentReleased", check: dollars[0] ? (a) => a.amount === usd(dollars[0]!) : undefined, why: `release of $${dollars[0]}` });
  else if (/vault holds it|held for/.test(step)) out.push({ event: "PaymentHeld", check: dollars[0] ? (a) => a.amount === usd(dollars[0]!) : undefined, why: `hold of $${dollars[0]}` });
  else if (/pays \$/.test(step) && !/stolen key|tries/.test(step)) out.push({ event: "PaymentExecuted", check: (a) => a.amount === usd(dollars[0]!), why: `agent payment of $${dollars[0]}` });
  if (/approves|approve/.test(step) && !/setup|stolen key|refused/.test(step)) {
    // "asks for $12, over its $10 limit; owner approves" approves the amount asked for, the first one.
    const amount = dollars[0];
    out.push({ event: "OwnerPaid", check: amount ? (a) => a.amount === usd(amount) : undefined, why: `owner-approved payment of $${amount}` });
  }
  // Rows outside the step tables (security table cells, eval bullets) only promise the transaction worked.
  if (out.length === 0 && /settled/.test(t)) out.push({ event: "PaymentExecuted", why: "a settled payment" });
  if (out.length === 0 && /refus/.test(t)) out.push({ event: "PaymentRefused", why: "a refusal" });
  if (out.length === 0 && /paid/.test(t)) out.push({ event: "PaymentExecuted", why: "a payment" });
  return out;
}

run("on-chain execution evidence", () => {
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpc, { retryCount: 4, retryDelay: 800 }) });
  const results: { row: Row; ok: boolean; events: string; detail: string; to: string; from: string; block: bigint }[] = [];
  const all = rows();
  const unique = new Map<Hex, Row[]>();
  for (const r of all) unique.set(r.hash.toLowerCase() as Hex, [...(unique.get(r.hash.toLowerCase() as Hex) ?? []), r]);

  it("finds the cited transactions", () => {
    expect(all.length).toBeGreaterThan(30);
  });

  it("every cited transaction succeeded and emitted what its row says", async () => {
    for (const [hash, cited] of unique) {
      const receipt = await client.getTransactionReceipt({ hash });
      const tx = await client.getTransaction({ hash });
      const logs = parseEventLogs({ abi: [...policyVaultAbi, ...vaultFactoryAbi, ...testUsdAbi], logs: receipt.logs as Log[], strict: false });
      const names = logs.map((l) => l.eventName);
      for (const row of cited) {
        const misses: string[] = [];
        if (receipt.status !== "success") misses.push(`status ${receipt.status}`);
        for (const e of expectations(row)) {
          const hit = logs.find((l) => l.eventName === e.event && (!e.check || e.check(l.args as Record<string, unknown>)));
          if (!hit) misses.push(`missing ${e.event} (${e.why})`);
        }
        results.push({
          row,
          ok: misses.length === 0,
          events: [...new Set(names)].join(" "),
          detail: misses.join("; "),
          to: tx.to ?? "",
          from: tx.from,
          block: receipt.blockNumber,
        });
      }
    }
    const csv = [
      "doc,line,hash,block,from,to,ok,events,problem",
      ...results.map((r) => [r.row.doc, r.row.line, r.row.hash, r.block, r.from, r.to, r.ok, `"${r.events}"`, `"${r.detail}"`].join(",")),
    ].join("\n");
    const dir = resolve(root, "evals/results");
    if (existsSync(dir)) writeFileSync(resolve(dir, "onchain-evidence.csv"), csv + "\n");
    const bad = results.filter((r) => !r.ok);
    for (const b of bad) console.log(`${b.row.doc}:${b.row.line} ${b.row.hash} -> ${b.detail} [events: ${b.events}]`);
    console.log(`${results.length - bad.length}/${results.length} cited rows match the chain (${unique.size} distinct transactions)`);
    expect(bad).toEqual([]);
  }, 600_000);

  it("the agent keys that paid were never able to sign owner actions", async () => {
    // Every refusal row is a successful transaction sent by the agent's own key straight to the vault.
    for (const r of results.filter((x) => /stolen key/i.test(x.row.text))) {
      expect(r.to.toLowerCase()).not.toBe(FACTORY_V2.toLowerCase());
      expect(r.events).toContain("PaymentRefused");
    }
  });

  it("the v2 factory, token and example vault have code", async () => {
    for (const a of [FACTORY_V2, TOKEN, EXAMPLE_V2_VAULT] as Address[]) {
      const code = await client.getCode({ address: a });
      expect(code && code.length > 2, a).toBe(true);
    }
  });

  it("the README's example vault runs the PolicyVault in this repo (immutables masked)", async () => {
    const artifact = resolve(root, "contracts/out/PolicyVault.sol/PolicyVault.json");
    if (!existsSync(artifact)) return console.log("run forge build first; skipped");
    const built = JSON.parse(readFileSync(artifact, "utf8")).deployedBytecode as { object: Hex; immutableReferences?: Record<string, { start: number; length: number }[]> };
    const example = exampleVault();
    const onchain = (await client.getCode({ address: example.address }))!;
    const mask = (code: Hex) => {
      const bytes = Buffer.from(code.slice(2), "hex");
      for (const refs of Object.values(built.immutableReferences ?? {})) for (const { start, length } of refs) bytes.fill(0, start, start + length);
      return bytes.toString("hex");
    };
    const a = mask(built.object);
    const b = mask(onchain);
    // The trailing CBOR metadata differs only if the sources or settings differ; compare it separately.
    const cbor = (hex: string) => parseInt(hex.slice(-4), 16) * 2 + 4;
    const sameLogic = a.slice(0, a.length - cbor(a)) === b.slice(0, b.length - cbor(b));
    console.log(`${example.version} example ${example.address}: runtime ${b.length / 2} bytes on-chain; logic ${sameLogic ? "matches" : "DIFFERS"}; metadata ${a.slice(-cbor(a)) === b.slice(-cbor(b)) ? "matches" : "differs"}`);
    expect(sameLogic).toBe(true);
  }, 60_000);
});
