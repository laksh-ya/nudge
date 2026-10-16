#!/usr/bin/env bash
# Checks every Base Sepolia transaction our docs cite, from a public RPC, without our backend:
# each row's wording is turned into the events the transaction must contain, and the receipt is
# decoded. Also compares the example vault's on-chain code with a local build of this repo.
#
#   scripts/verify-evidence.sh                 # public Base Sepolia RPC
#   EVIDENCE_RPC=https://… scripts/verify-evidence.sh
#
# Read-only: no keys, no transactions. Writes evals/results/onchain-evidence.csv.
set -uo pipefail
cd "$(dirname "$0")/.."
export EVIDENCE_RPC="${EVIDENCE_RPC:-https://sepolia.base.org}"
if command -v forge >/dev/null; then (cd contracts && forge build >/dev/null) || true; else echo "forge not found: the bytecode comparison is skipped"; fi
pnpm --filter @agent-wallet/domain exec vitest run evidence.e2e --silent=false 2>&1 | grep -E "cited rows|runtime|->|✓|×|Tests " || true
node -e '
const rows = require("fs").readFileSync("evals/results/onchain-evidence.csv", "utf8").trim().split("\n").slice(1);
const cell = (r) => r.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, "").replace(/^"|"$/g, ""));
for (const r of rows) { const [doc, line, hash, , , , ok, events, problem] = cell(r); console.log(`${ok === "true" ? "PASS" : "FAIL"}  ${doc}:${line}  ${hash.slice(0, 12)}…  ${events}${problem ? "  (" + problem + ")" : ""}`); }
const bad = rows.filter((r) => cell(r)[6] !== "true").length;
console.log(`\n${rows.length - bad}/${rows.length} rows pass`);
process.exit(bad ? 1 : 0);
'
