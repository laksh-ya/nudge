#!/usr/bin/env bash
# Run the same attacks against a hot wallet, a capped wallet (the common hackathon design) and
# PolicyVault, with stolen agent keys and our server bypassed. Writes evals/results/contract-attacks.csv.
set -euo pipefail
cd "$(dirname "$0")/../contracts"
out=../evals/results/contract-attacks.csv
echo 'scenario,source,hot wallet lost ($),capped wallet lost ($),PolicyVault lost ($),legit $8 payment' > "$out"
ATTACKS_CSV=true forge test --match-contract AttacksTest -vv | grep -E "^\[(PASS|FAIL)"
echo "wrote $out"
