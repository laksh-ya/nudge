# Tests

Three kinds of test live here, from fastest to most real. `pnpm test` at the repository root runs the unit tests below, the backend tests (`packages/backend/convex/*.test.ts`) and the contract tests (`contracts/test`). The rest skip themselves unless their environment is set, because they spend test gas or call a model.

## Unit (run on every `pnpm test` and in CI)

| File | What it checks |
|---|---|
| `vault.test.ts` | The vault's action encoding and digest match the contract byte for byte |
| `webauthn.test.ts` | Passkey assertions are packed the way the contract verifies them |
| `approval-truth.test.ts` | The approval page shows what will actually be signed |
| `proof.test.ts` | On-chain events decode into the right proof-page lines |
| `statements.test.ts`, `review.finance.test.ts` | Statement parsing and the ledger maths |
| `gateway.audit.test.ts` | The MCP gateway's controls, against an in-memory database |

## Local chain (Anvil, no testnet)

| File | Run with |
|---|---|
| `vault.int.test.ts` | Passkey path against the real contract on Anvil (deploy first; the header lists `ANVIL_URL`, `TOKEN`, `FACTORY`) |
| `settlement.fault.test.ts` | Settlement when a held payment's release broadcast is lost (finding on #57), with the real backend in-process (`anvil --chain-id 84532 --port 8546`, `forge build`) |
| `agent.eval.test.ts` | 54 prompt-injection and task cases, model alone vs the full system: `anvil --chain-id 84532 --port 8546`, then `EVAL=1 vitest run agent.eval` (set `ANTHROPIC_API_KEY` for real models) |
| `chat-rules.eval.test.ts` | The rule-based chat (what answers on prod) against the same attacks |

## Base Sepolia, through a real deployment

These make their own demo sandbox and vault, and write transaction links to `$TMPDIR`. They never touch the judge account.

| File | What it proves |
|---|---|
| `onchain.e2e.test.ts` | The whole path: passkey enrolment, vault and rules, paying at once, held then released, owner approval, a stolen key refused and frozen, delayed unfreeze, chat freeze, disconnect, and the owner paying and withdrawing |
| `resilience.e2e.test.ts` | Four racing payments never exceed the limit; a lost receipt settles once |
| `guardian.e2e.test.ts` | A guardian stops a held payment (`GUARDIAN=1`) |
| `mandates.e2e.test.ts` | AP2 mandates from a real vault verify on-chain |
| `multi-agent.e2e.test.ts` | Two assistants from different vendors on one vault (`MULTI_AGENT=1`) |
| `live-attacks.e2e.test.ts` | Attacks on our own sandboxes on a deployment |
| `evidence.e2e.test.ts` | Every transaction the docs cite, re-read from the chain |
| `load.e2e.test.ts` | Many visitors opening sandboxes at once |

```bash
E2E_CONVEX_URL=https://<deployment>.convex.cloud E2E_DEMO_JWK=/path/to/demo-private.jwk.json \
  pnpm --filter @agent-wallet/domain exec vitest run onchain.e2e
```

Each file's header lists what else it needs. `e2e-harness.ts` holds the shared sandbox, passkey and MCP helpers; `eval/` holds the eval world, cases and judge.
