#!/usr/bin/env bash
# Deploy TestUSD and VaultFactory to Base Sepolia, then point both Convex deployments at them.
# Needs contracts/.env with RELAYER_PRIVATE_KEY, and that address funded with a little Base Sepolia ETH.
set -euo pipefail
cd "$(dirname "$0")"
source .env
balance=$(cast balance "$RELAYER_ADDRESS" --rpc-url https://sepolia.base.org)
if [ "$balance" = "0" ]; then echo "Fund $RELAYER_ADDRESS with Base Sepolia ETH first"; exit 1; fi
out=$(RELAYER_PRIVATE_KEY=$RELAYER_PRIVATE_KEY forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast 2>&1)
token=$(echo "$out" | grep -oE "TestUSD 0x[0-9a-fA-F]{40}" | cut -d' ' -f2)
factory=$(echo "$out" | grep -oE "VaultFactory 0x[0-9a-fA-F]{40}" | cut -d' ' -f2)
[ -n "$token" ] && [ -n "$factory" ] || { echo "$out" | tail -20; exit 1; }
echo "TestUSD      $token"
echo "VaultFactory $factory"
cd ../packages/backend
for flag in "" "--prod"; do
  npx convex env set $flag RELAYER_PRIVATE_KEY "$RELAYER_PRIVATE_KEY" >/dev/null
  npx convex env set $flag FACTORY_ADDRESS "$factory" >/dev/null
  npx convex env set $flag TOKEN_ADDRESS "$token" >/dev/null
done
npx convex env set --prod RP_IDS "agent-wallet-approve.vercel.app" >/dev/null
echo "Convex dev and prod now use these contracts."
