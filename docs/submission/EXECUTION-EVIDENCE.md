# Execution evidence

Nudge uses Base Sepolia, chain ID 84532, and valueless test tUSD. These examples come from the committed 17 October scenarios in [evals/README.md](../../evals/README.md). Receipts verify contract events and token movements. A receipt alone does not prove a natural-language conversation, a real phone, or who controlled a UI.

| Scenario and contract result | Vault | Full transaction |
|---|---|---|
| Claude's $6 payment is held | `0x1bAc392A06A058A72A8B0fb1dF4b3F8686CA3747` | [Hold](https://sepolia.basescan.org/tx/0x93c7ceae0d8ef0205966df68a96b038a73489a0bf1eb4c382b00256c97352598) |
| Guardian stops the held payment | Same guardian-demo vault | [Cancellation](https://sepolia.basescan.org/tx/0x338a1ffe3619581ea84e9cc65fb0f8e34a8165bdbe56dcad67fba384d0d2c5dc) |
| Claude's $6 payment is held | `0x31F68A8d36e4392725d2F09261D42a529e6aDc32` | [Hold](https://sepolia.basescan.org/tx/0x4789873e59d32bae28a9960b50f66c0109a2cf089729a0134184ac8706bec44c) |
| Claude's $6 held payment is released | Same multi-assistant vault | [Release](https://sepolia.basescan.org/tx/0x6ada88b4296443c895af6a9f8482a3c99cc262c0830617d859ac3c8caa81e0f0) |
| Hermes's $7 payment is held | Same multi-assistant vault | [Hold](https://sepolia.basescan.org/tx/0x892203135b4d83bd0da98a6cbd83c0a627a91f593ad2bb630a8f25f7f2c708ae) |
| Hermes's $7 held payment is released | Same multi-assistant vault | [Release](https://sepolia.basescan.org/tx/0x2ce1ea19e768ce0b6583556dd68288cd5b8770325a9db1bfc54c8fda8966a29b) |

For each hold/release pair, match `paymentId`, vault emitter, amount and contact, then check the token transfer on release. For cancellation, check that the same held payment is cancelled and not released. The detailed scenario tests also inspect final state; a single receipt does not establish the absence of a later transfer.

The full [receipt CSV](../../evals/results/onchain-evidence.csv) at source `6533942` has 88 cited rows and 72 distinct hashes marked successful by its original run. It is a historical artifact. `bash scripts/verify-evidence.sh` creates a fresh check, fails on test or RPC errors, and does not use old CSV results as evidence of a new successful run. The original verifier infers expected events from prose; exact claim semantics and emitter identity still need review. A successful HTTP response or receipt status alone is not proof of every product claim.

The [54-task table](../../evals/TASKS.md) maps owner instructions to outcomes for the dated Claude Opus MCP evaluation. It runs against local Anvil, not Base Sepolia. Its 53/54 score includes one missing MCP freeze task. [Raw results](../../evals/results/agent-injection-claude-mcp.csv) and [scope/caveats](../../evals/results/agent-injection-claude-mcp-summary.md) accompany it. Do not represent those rows as 54 public-testnet transactions.

## Judge verification

1. Use the fixed submitted commit and install its locked dependencies as described in the root README.
2. Run `bash scripts/verify-evidence.sh` from a machine with public Base Sepolia RPC access. Installing Foundry also enables the code comparison; absence of Foundry is reported as a skipped comparison.
3. Open the transaction links and inspect block timestamps, status, emitting contract, decoded event and amount. Use the CSV block/from/to columns to cross-check the cited transaction.
4. Read the known-risk section before interpreting the evaluation. An in-limit payment to a compromised saved contact remains possible.
5. Use the final video to inspect the actual phone and assistant interaction. Judge credentials and approval capabilities must be delivered privately, never committed here.
