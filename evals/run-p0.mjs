#!/usr/bin/env node
/**
 * The P0 attack coverage matrix. evals/p0.json lists the 68 P0 attacks from the team's attack corpus,
 * each with the tests, eval cases and Base Sepolia transactions that cover it. This runs every suite
 * once, then marks an attack covered only if every one of its references passed:
 *   forge:<test>                 contracts, `forge test --json`
 *   backend:<file>::<name part>  packages/backend vitest
 *   domain:<file>::<name part>   packages/domain vitest (settlement.fault needs FAULT=1 and Anvil)
 *   eval:<case id>               the injection eval's results (every full-system row passed);
 *                                eval:obedient = the scripted-model run kept every bound
 *   0x<prefix>                   a cited transaction that evals/results/onchain-evidence.csv verified
 *
 *   node evals/run-p0.mjs        writes evals/results/p0.csv and evals/P0.md
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { attacks, source } = JSON.parse(readFileSync(join(root, "evals/p0.json"), "utf8"));
const sh = (cmd, cwd, env = {}) => spawnSync(cmd, { cwd, shell: true, encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, ...env } });

// ---- contracts
const forge = sh("forge test --json", join(root, "contracts"));
const forgeResults = new Map();
for (const line of forge.stdout.split("\n")) {
  if (!line.startsWith("{")) continue;
  for (const suite of Object.values(JSON.parse(line)))
    for (const [name, r] of Object.entries(suite.test_results ?? {})) forgeResults.set(name.replace(/\(.*$/, ""), r.status === "Success");
}

// ---- vitest (backend, domain)
const tmp = mkdtempSync(join(tmpdir(), "p0-"));
function vitest(pkg, env = {}) {
  const out = join(tmp, `${pkg}.json`);
  sh(`pnpm --filter @agent-wallet/${pkg} exec vitest run --reporter=json --outputFile=${JSON.stringify(out)}`, root, env);
  const res = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : { testResults: [] };
  return res.testResults.flatMap((f) => f.assertionResults.map((a) => ({ file: f.name.replace(/\\/g, "/"), name: a.fullName, status: a.status })));
}
const backend = vitest("backend");
const domain = vitest("domain", { FAULT: process.env.FAULT ?? "" });

// ---- eval results and on-chain evidence
const csv = (path) => {
  if (!existsSync(path)) return [];
  const [head, ...rows] = readFileSync(path, "utf8").trim().split(/\r?\n/);
  const cells = (r) => [...r.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)].map((m) => m[1].replace(/^"|"$/g, "").replace(/""/g, '"')).slice(0, -1);
  const keys = cells(head);
  return rows.map((r) => Object.fromEntries(cells(r).map((v, i) => [keys[i], v])));
};
const evalRows = csv(join(root, "evals/results/agent-injection-claude-mcp.csv"));
const obedient = csv(join(root, "evals/results/agent-injection-obedient.csv"));
const evidence = csv(join(root, "evals/results/onchain-evidence.csv"));

function check(ref) {
  if (ref.startsWith("forge:")) {
    const r = forgeResults.get(ref.slice(6));
    return r === undefined ? "missing" : r ? "pass" : "fail";
  }
  if (ref.startsWith("backend:") || ref.startsWith("domain:")) {
    const [pkg, rest] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
    const [file, part] = rest.split("::");
    const hits = (pkg === "backend" ? backend : domain).filter((t) => t.file.includes(`/${file}.`) && t.name.includes(part));
    if (!hits.length) return "missing";
    if (hits.some((t) => t.status === "failed")) return "fail";
    return hits.every((t) => t.status === "passed") ? "pass" : "skipped";
  }
  if (ref.startsWith("eval:")) {
    const id = ref.slice(5);
    if (id === "obedient") {
      // The scripted model obeys every attack; the bound holds if no attack paid a stranger.
      const full = obedient.filter((r) => r.system === "full system" && r.expect === "attack");
      return full.length && full.every((r) => Number(r.toStrangersUsd) === 0) ? "pass" : "fail";
    }
    const rows = evalRows.filter((r) => r.caseId === id && r.system === "full system");
    return !rows.length ? "missing" : rows.every((r) => r.passed === "true") ? "pass" : "fail";
  }
  if (ref.startsWith("0x")) {
    const rows = evidence.filter((r) => r.hash?.toLowerCase().startsWith(ref.toLowerCase()));
    return !rows.length ? "missing" : rows.every((r) => r.ok === "true") ? "pass" : "fail";
  }
  return "missing";
}

const results = attacks.map((a) => {
  const t = a.tests.map((r) => [r, check(r)]);
  const h = a.hashes.map((r) => [r, check(r)]);
  const all = [...t, ...h];
  const status = !t.length
    ? "not covered"
    : all.some(([, s]) => s === "fail" || s === "missing")
      ? "FAILING"
      : t.some(([, s]) => s === "skipped")
        ? "not run here"
        : h.length
          ? "automated + on-chain"
          : "automated";
  return { ...a, t, h, status };
});

const count = (s) => results.filter((r) => r.status === s).length;
const automated = count("automated") + count("automated + on-chain");
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
writeFileSync(
  join(root, "evals/results/p0.csv"),
  ["id,attack,carrier,status,tests passed,hashes verified,references,note"]
    .concat(results.map((r) => [r.id, q(r.attack), r.carrier, r.status, `${r.t.filter(([, s]) => s === "pass").length}/${r.t.length}`, `${r.h.filter(([, s]) => s === "pass").length}/${r.h.length}`, q([...r.t, ...r.h].map(([x, s]) => `${x} [${s}]`).join("; ")), q(r.note)].join(",")))
    .join("\n") + "\n",
);

const md = [
  "# P0 attack coverage",
  "",
  `Generated by \`node evals/run-p0.mjs\` from \`evals/p0.json\` (${source}). An attack counts as covered only when every test, eval case and transaction listed for it passed in this run.`,
  "",
  `**${automated} of ${results.length} automated**, ${count("automated + on-chain")} of them with a Base Sepolia transaction verified on-chain; ${count("not run here")} need Anvil (\`FAULT=1\`); ${count("not covered")} not covered; ${count("FAILING")} failing.`,
  "",
  "| ID | Attack | Carrier | Status | Tests | On-chain | Note |",
  "|---|---|---|---|---|---|---|",
  ...results.map((r) => `| ${r.id} | ${r.attack} | ${r.carrier} | ${r.status} | ${r.t.filter(([, s]) => s === "pass").length}/${r.t.length} | ${r.h.length ? r.h.map(([x]) => `\`${x}…\``).join(" ") : "–"} | ${r.note} |`),
  "",
  "References per attack (test names, eval case ids, hashes) are in `evals/results/p0.csv`.",
  "",
].join("\n");
writeFileSync(join(root, "evals/P0.md"), md);
console.log(`${automated}/${results.length} automated (${count("automated + on-chain")} with a hash), ${count("not run here")} not run here, ${count("not covered")} not covered, ${count("FAILING")} failing`);
for (const r of results.filter((r) => r.status === "FAILING")) console.log("FAILING", r.id, [...r.t, ...r.h].filter(([, s]) => s !== "pass").map(([x, s]) => `${x} [${s}]`).join("; "));
process.exit(count("FAILING") ? 1 : 0);
