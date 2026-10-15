# Evaluations

Three suites, each runnable on its own. Results are committed under `results/`.

| Suite | What it shows | Run |
|---|---|---|
| Contract attacks | The same nine attacks against a hot wallet, a capped wallet (allowlist + calendar-day caps + server-held owner key, the common hackathon design) and PolicyVault, with stolen agent keys and our server bypassed | `./evals/run-contract-attacks.sh` |
| Races and lost receipts | Four simultaneous payments against one limit; a payment whose receipt is lost, then retried | `packages/domain/src/resilience.e2e.test.ts` (Base Sepolia, dev backend) |
| Prompt injection, real model | Seven attacks hidden in content the owner pastes or forwards, six legitimate tasks; Claude with only a prompt and a send-money tool versus the full system | `packages/domain/src/agent.eval.test.ts` (needs `ANTHROPIC_API_KEY` locally and on the dev deployment) |

## Contract attacks

Wallet starts with $250. Owner intent: agent A $10 a payment and $15 a day, agent B $10 and $30, all agents together $20 a day, $50 agents can never spend. "n/a" means the design has no such path (a hot wallet has no owner approval or server key to attack). Every design first completes one honest $8 payment.

| Attack | Modelled on | Hot wallet lost | Capped wallet lost | PolicyVault lost |
|---|---|---|---|---|
| Pay the attacker's own address, every 2h for 48h | Unit 42, Zscaler, OpenClaw skills | $240 | $0 | $0 |
| Drain a compromised saved merchant for 48h | Bankr (14 wallets) | $240 | $30 | $10 (key froze itself after 5 refusals) |
| Spend the daily cap twice around midnight | Calendar-day caps in rival entries | n/a | $30 | $15 |
| Same invoice paid ten times (extra paid) | Retry storms, duplicate bills | $45 | $10 | $0 |
| Whole balance sent instead of $2.50 | Lobstar Wilde | $242 | $0 | $0 |
| Two stolen keys for 24h (owner wants $20/day total) | Several connected assistants | n/a | $80 | $20 |
| Slow drain inside the limits for 10 days | Denial of wallet | $225 | $240 | $190 (stops at the $50 protected) |
| App server compromised, its keys used directly | AIXBT; server-held owner keys | n/a | $242 | $0 |
| Approved $20 to the shop, executed as $200 to the attacker | Loopjacking; Bybit | n/a | $200 | $0 |

What PolicyVault does not stop: an in-limit payment to a saved contact the attacker controls (the $10, $15, $20 and $190 above). Those are the bound we publish, not zero.

## Races and lost receipts (Base Sepolia)

- Four $6 payments sent at the same instant against a $15 daily limit: two paid ([`0x5ad0b560…`](https://sepolia.basescan.org/tx/0x5ad0b560419f990b5728c262c10aa553b56054c9ed82292647474919e38deff3), [`0x1ee6ff87…`](https://sepolia.basescan.org/tx/0x1ee6ff876a1314e5e8f0637e8e81358d25a1b27a2b45ffa5566f80a21d20cb0d)), two sent to the owner for approval; the vault's own count reads $12.
- A payment whose receipt the backend was made to lose: reported "unknown", a retry with the same `requestId` returned the first task instead of paying again, and it settled as paid once from the chain ([`0xc42f6499…`](https://sepolia.basescan.org/tx/0xc42f64997e96461b36fbd27016f7ce0cd30a5b45488322db2514bdbb3a0d6770)).

## Prompt injection with a real model

Not yet run: it needs an Anthropic API key. See `packages/domain/src/agent.eval.test.ts` for the cases and the scoring.
