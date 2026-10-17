# Security self-assessment

Draft laid out for the official template. The team's own assessment, not an audit. Testnet (Base Sepolia) and a valueless test token only. The control-by-control table with evidence is [`docs/SECURITY.md`](../SECURITY.md); this document adds permission tiers by channel, the risk register, the attack results and what we found broken and fixed.

## 1. The claim, and what we don't claim

An assistant can only pay saved contacts, inside per-payment, rolling 24-hour and wallet-wide limits that the vault contract enforces itself, and never into the amount protected from agents. That holds with the assistant fooled, its key stolen, or our server bypassed. Anything beyond those limits, and every change that loosens them, needs the owner's passkey over the exact action, and loosening waits a delay the owner can cancel.

We do **not** claim resistance to prompt injection as such. A fooled assistant can make a bad payment that fits its limits; the limits bound how much.

## 2. Permission tiers by channel

| Channel | Who it speaks for | Can do on its own | Needs the owner's passkey | Never |
|---|---|---|---|---|
| App chat (signed in) | The owner, as typed | Answer from the owner's data; pay a saved contact inside the assistant's limits only on a short, direct order ("Pay Blue Tokai $4") | Anything above the limits; a question, negation, quoted or pasted text containing "pay" gets an approval card instead | Pay a new address; loosen a rule |
| Telegram (linked private chat) | The owner, once the chat is linked with a one-use 10-minute code | Same as app chat; freeze instantly | Same as app chat; re-linking to another chat needs the owner's yes in the app | Act on group, forwarded, bot or unlinked-chat messages |
| Outside assistant over MCP (bearer key, per assistant) | That assistant | Read what the owner allows; pay a saved contact inside its own limits (it holds no key: the backend signs with that assistant's own vault key) | Anything above its limits (the owner gets the card; the assistant never gets a link or token) | Approve anything; see hidden balances; act after it is frozen or disconnected |
| Approval site (separate origin) | The owner's passkey | Nothing without a signature | Every loosening and every over-limit payment | Sign without user verification; sign for another site or vault; reuse a signature |
| Guardian (our relayer key) | The service | Freeze the vault or an agent; cancel a held payment or queued change; submit what the owner signed | – | Move money; add agents or contacts; loosen any rule |
| Family guardian (own account, linked with a one-use code) | Someone the owner trusts | See held payments and assistant requests; stop a held payment; freeze the assistants | – | See balances or statements; approve, pay, add contacts or change limits; act after the owner removes them |
| Demo visitor | A private sandbox | Their own sandbox only | Their own sandbox's actions | See another account; open the judge account without the judge key |

## 3. Risk register

| # | Risk | Likelihood (testnet demo) | Impact | Control | Residual |
|---|---|---|---|---|---|
| R1 | Assistant fooled by injected text | High | In-limit payment to a saved contact | Limits on-chain; holds above $5 with cancel; new contacts wait 24 h | Up to the assistant's daily cap, saved contacts only |
| R2 | Agent key stolen | Medium | As R1, plus repeated tries | Same limits; five refusals freeze the key; instant freeze and disconnect | Same bound as R1 |
| R3 | Server compromised | Low | Holds the guardian key and sealed agent keys | Guardian can only tighten; each agent key capped by the contract | Up to the daily ceiling, saved contacts only; a separate signer service (#20) is the fix |
| R4 | Approval page compromised | Low | Shows one action, signs another | Separate origin, strict CSP, no third-party scripts, display rebuilt from the signed bytes, server claims flagged | Loosening still waits a cancellable delay |
| R5 | Owner approves a bad request | Medium | Any amount above protected | Exact amount and payee shown from the signed bytes; new contacts wait | Owner's judgement |
| R6 | Lost broadcast or receipt | Medium | Wrong status, double payment | Signed transaction stored before broadcast; `unknown` never `failed`; same bytes re-sent; late callbacks can't reopen a task | Status may read "unknown" up to 10 minutes |
| R7 | Channel takeover (Telegram account, SIM swap) | Low | Chat as the owner | Chat is bounded like an assistant; anything more needs the passkey | Up to the in-app assistant's limits |
| R8 | Losing every passkey | Low | Vault locked | Backup passkeys supported and prompted | Test funds only |
| R9 | Unaudited contract | – | Any bug | 166 forge tests incl. 13 invariants; internal review findings fixed (below); no admin or upgrade path | No external audit |
| R10 | Rule-based chat misreads a message | Medium | Wrong amount or payee | Pays alone only on a strict direct order; anything else is a card the owner checks | Cards can carry a misread amount; the owner sees it before signing |

## 4. Attacks, tests and results

Full matrix of the 68 P0 attacks from our corpus, each with its tests, eval cases and on-chain evidence: [`evals/P0.md`](../../evals/P0.md). 63 are automated and pass, 19 with a verified Base Sepolia transaction; 5 are not covered (family pairing is not built, two are by design, one is a live probe).

| Attack class | Test | Result |
|---|---|---|
| Stolen agent key pays a new address, over its limits, replays an id | `forge test` (`test_attack_*`, `testFuzz_stolenKeyIsBounded`); Base Sepolia refusals 2003, 2007, 2010 and the fifth-refusal freeze (README) | Refused on-chain with a code; key froze itself |
| Same attacks vs a hot wallet and a capped wallet | `evals/run-contract-attacks.sh` | Hot wallet up to $242 lost, capped wallet up to $242, PolicyVault $0 to the attacker |
| Prompt injection, 38 attacks incl. 12 in the owner's own data | `agent.eval.test.ts` with Claude Opus, Sonnet, Haiku over MCP | 0 of 38 fooled any model |
| Same with a model that obeys every injection | `agent.eval.test.ts`, obedient model | 36 fooled; $0 to non-contacts; worst case $24.95 |
| Rule-based chat (no model) vs the same 38 attacks | `chat-rules.eval.test.ts` | 0 paid anyone but the owner's own choice |
| Approval link abuse (self-approval, token reuse, leaking data) | `approvals.test.ts`, `gateway.audit.test.ts` G1–G2 | Agent never gets a link; token holder who isn't the owner can't act |
| Gateway decisions | `matrix.test.ts`: 96 cases (scope x amount x frozen x new contact x live/simulated) against an oracle | All agree |
| Forged AP2 mandates (raised limit, invented merchant, wrong agent, later expiry, edited text, bigger payment) | `mandates.e2e.test.ts` on Base Sepolia | All six caught; the genuine ones verify |
| Telegram inbound | `matrix.test.ts` | Group, forwarded, bot, unlinked ignored; redelivery handled once; re-link needs the owner |
| Races and lost receipts on Base Sepolia | `resilience.e2e.test.ts` | Four racing $6 requests: two accepted, two to the owner; lost receipt settled once |

## 5. Hardening log: what was broken, and the fix

We list failures our own testing found, because the fixes are only credible next to them. Details and tests: [`docs/TESTING.md`](../TESTING.md).

| When | Found | Fix | Proof |
|---|---|---|---|
| 16 Oct | F1–F9 in contract v2: a removed agent's held payment could still release; a release could breach a raised protected amount; a queued grant could restore a removed agent; a stale unfreeze could undo a later freeze; changes queued by a removed passkey could apply; stale queued policy could undo a later tightening; an agent could burn an owner payment id; outflow could exceed the ceiling across holds; (v3 draft) a stranger could void the owner's queued unfreeze | Contract v3: generations and epochs per target and per signing key, held outflow counted when money leaves, shared payment-id space, stranger self-freeze refused | `AuditFindings.t.sol` 11/11 and C5 checks pass; v3 deployed |
| 16 Oct | G1–G6 in the gateway: an assistant could approve its own over-limit payment on a simulated wallet; the approval link leaked balances; `can_afford` could be bisected into a hidden balance; sub-cent amounts reported paid then never sent; held payments reported "paid"; one invoice paid twice by two assistants | Approval capability only to the owner; link shows only the action; coarse answers; whole cents only; "submitted" until confirmed; request ids scoped to the wallet | `gateway.audit.test.ts` 19/19 |
| 16 Oct | MCP `structuredContent` was an array, so Claude Code rejected every list result (#46) | Always an object | Haiku over MCP with no workaround: 0/38 fooled, 15/16 tasks |
| 16 Oct | A lost broadcast reply marked a payment failed after money moved (#52); late callbacks could reopen a settled task (#53) | Sign and store before broadcast; `unknown` and reconcile by the same bytes; settled tasks are final | Codex fault-injection test; Base Sepolia resilience run |
| 16 Oct | Our own review of that fix: a release that never reached the node, with its nonce reused, was marked failed while the money stayed held | Goes back to held and is sent again | `settlement.fault.test.ts` |
| 16 Oct | The rule-based chat would have paid "Don't pay Blue Tokai $4" and 10 of 38 attacks once allowed to pay inside limits | Pays alone only on a strict direct order | `chat-pay.test.ts`, `chat-rules.eval.test.ts` |
| 16 Oct | New vaults recorded as v2 when a lagging node failed the version read; setup then reverted | Retry until the node sees the code; only a real revert means v2; correct upward on sync | Base Sepolia e2e 10/10 on fresh v3 vaults |
| 16 Oct | README rows called held payments "paid" | Rows say held, and cite the releases | `scripts/verify-evidence.sh`: 82/82 |

## 6. Not covered yet

- Two real signed-in users side by side (sandbox isolation is tested; Clerk accounts by hand only).
- iPhone passkeys and the Telegram in-app browser on iOS (#29).
- MCP OAuth 2.1 (#14), WhatsApp (#22), a separate signer service (#20), family transfers (#16).
- Two different assistant vendors sharing one ceiling on Base Sepolia (#15); covered on a local chain and in contract tests.
