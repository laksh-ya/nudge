#!/usr/bin/env bash
# Regenerate packages/domain/src/abi.ts from the compiled contracts.
set -euo pipefail
cd "$(dirname "$0")"
forge build >/dev/null 2>&1
out=../packages/domain/src/abi.ts
{
  echo "// Generated from contracts/ with forge inspect (contracts/abi.sh). Do not edit by hand."
  echo "export const policyVaultAbi = $(forge inspect PolicyVault abi --json | tr -d '\n') as const;"
  echo
  echo "export const vaultFactoryAbi = $(forge inspect VaultFactory abi --json | tr -d '\n') as const;"
  echo
  echo "export const testUsdAbi = $(forge inspect TestUSD abi --json | tr -d '\n') as const;"
} > "$out"
echo "wrote $out"
