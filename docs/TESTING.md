# Testing report

16 October 2026, commit `680daf9`. Independent review run by Claude Code for the team. Everything below was run on this commit; nothing was deployed, no transaction was sent, and no product code was changed. New test files are listed at the end.

## Results at a glance

| Suite | Command | Result |
|---|---|---|
| Contract unit and fuzz tests | `forge test --match-contract PolicyVaultTest` | 44 / 44 pass (fuzz 512 runs) |
| Contract invariants, no holds | `forge test --match-contract PolicyVaultInvariant` | 2 / 2 pass (128 runs, 8,192 calls each) |
| Attacks vs hot wallet and capped wallet | `./evals/run-contract-attacks.sh` | 9 / 9 pass; dollar figures match `evals/README.md` |
| **New:** invariants with holds, releases, cancels, freezes, a stolen key | `forge test --match-contract AuditInvariant` | 4 / 4 pass (128 runs, 32,768 calls each) |
| **New:** lifecycle findings F1–F9 | `forge test --match-contract AuditFindings` | 1 / 11 pass on this commit. Each test states the intended property; ten reproduce a gap, F9 is a guard that passes here |
| Static analysis | `slither . --filter-paths "node_modules\|lib/\|test/\|script/"` | No high or medium issues. Informational only: timestamp use, sentinel `== 0` checks, `balanceOf` inside a batch loop, a missing zero check in the factory constructor (the vault constructor already rejects zero) |
| Typecheck, all four packages | `pnpm typecheck` | 4 / 4 pass |
| Domain unit tests | `pnpm --filter @agent-wallet/domain exec vitest run` | 16 / 16 pass (encoding, digest, statements) |
| Passkey path on a local chain | `vault.int.test.ts` against Anvil (chain id 84532) | 2 / 2 pass, including browser-shaped high-s signatures |
| **New:** MCP gateway and approval link | `vitest run gateway.audit` | 13 / 13 controls hold; 0 / 6 findings G1–G6 pass |
| **New:** on-chain evidence check | `EVIDENCE_RPC=https://sepolia.base.org vitest run evidence.e2e` | 42 distinct transactions, 56 / 58 cited rows match the chain; deployed v2 vault logic matches this source |
| Ledger and parser counterexamples (Codex review) | `audit-review.test.ts` in the review checkout | 6 / 6 still reproduce on this commit |
| Live deployment, read-only probes | `curl`, see below | Approval site headers strong; MCP and Telegram refuse unauthenticated calls; dashboard has no CSP |
| Prompt injection with a real model | `agent.eval.test.ts` | **Not run.** Needs an Anthropic key and the dev deployment |
| Base Sepolia end to end, races, lost receipts | `onchain.e2e`, `resilience.e2e` | Not rerun (needs relayer and demo keys). Their recorded transactions were checked on-chain instead |

## What holds

These were tried and the code did the right thing.

- A stolen agent key with our server bypassed cannot pay an unsaved address, exceed per-payment, daily or vault limits, touch the protected amount, or replay a payment id (unit tests, fuzz `stolenKeyIsBounded`, 9 attack scenarios).
- With holds switched on and random releases, cancels and freezes: the vault never drops below the protected amount, money only reaches the saved contact, `heldTotal` always equals the sum of held payments, and accepted requests in any 24 hours stay under the ceiling (`AuditInvariant`, 4 × 32,768 calls).
- The owner passkey is checked on-chain: wrong site, missing user verification, tampered action, other key, replay and expired deadline all revert.
- The MCP gateway refuses unknown and raw-address contacts, sends over-limit payments to the owner, counts payments in flight so a burst can't pass the daily cap, refuses requestIds carrying free text, stops frozen and disconnected assistants, keeps the protected amount, and never forwards the agent's own wording in the owner's Telegram notice (`gateway.audit.test.ts`, "holds").
- A passkey-bound approval cannot be approved through the link without the passkey.
- Every transaction cited in `README.md`, `docs/SECURITY.md` and `evals/README.md` exists on Base Sepolia, succeeded, and emitted the event its row describes, except the two noted below. Refusals 2003, 2007 and 2010, the self-freeze on the fifth strike, queued and applied unfreezes, holds, releases and owner payments are all confirmed by decoded events.
- The runtime code of the example v2 vault (`0xa395…4E73`) matches `forge build` of this commit with immutables masked. Only the metadata hash differs, so the logic on-chain is this source.

## Findings

Severity is for this prototype on a test network. "Test" names the failing test that demonstrates the gap; each passes once the gap is fixed.

### Contract (`contracts/test/AuditFindings.t.sol`)

| # | Severity | What happens | Test | Suggested fix |
|---|---|---|---|---|
| F5 | High | **Lost phone.** The thief signs `Withdraw(all)` with the stolen passkey; it queues. The owner removes that passkey with the backup key. After the delay the thief's withdrawal still applies, because a queued change doesn't record which key signed it. The demo delay is 2 minutes. | `test_F5_actionsQueuedByARemovedPasskeyMustNotApply` | Store the signing `keyId` with each queued change; `finalize` requires it still active. Removing a key cancels its queued changes. |
| F1 | Medium | Disconnect (freeze, then `RemoveAgent`) deletes the agent record, frozen flag included, so its held payment releases afterwards. (Codex review.) | `test_F1_removedAgentsHeldPaymentMustNotRelease` | `release` requires `agents[h.agent].active`; `RemoveAgent` cancels that agent's held payments. |
| F3 | Medium | A grant queued before revocation applies after it and brings the removed agent back. (Codex review.) | `test_F3_queuedGrantMustNotRestoreRemovedAgent` | Per-agent epoch, bumped by `RemoveAgent` and freezes; queued grants carry the epoch they were signed under. |
| F4 | Medium | The owner signs an unfreeze (queued). The guardian freezes the vault again for a new incident. The older unfreeze still applies, and `finalize` lets exactly that op through a frozen vault. | `test_F4_staleUnfreezeMustNotUndoALaterFreeze` | A freeze bumps a freeze epoch; an unfreeze applies only if no freeze happened after it was signed. |
| F6 | Medium | The owner queues a looser ceiling, then raises the protected amount (applies at once). `SetPolicy` carries all six fields, so the older queued change later resets protection to the old value. | `test_F6_staleQueuedPolicyMustNotUndoALaterTightening` | Record a policy version in the queued change and reject it if policy changed since, or apply only the loosened fields. |
| F2 | Medium | Raise the protected amount while a payment is held: the release still takes the vault below it. (Codex review.) | `test_F2_releaseMustNotBreachRaisedProtectedAmount` | `release` checks `balance - amount >= protectedAmount`, or raising protection cancels holds that would breach it. |
| F8 | Low | The ceiling counts a held payment when requested; the money leaves when released. Holds at the end of one window plus instant payments at the start of the next move $80 within 24 hours against a $40 ceiling. | `test_F8_outflowInAny24HoursMustStayUnderTheCeiling` | Either also count at release, or state the bound as "ceiling plus what is held" everywhere the worst case is shown. |
| F5b | High | The realistic order of F5: the thief's Withdraw was queued first, so it is ready before the owner's removal of that key applies. Signing the removal must stop the key's queued changes at once. | `test_F5b_signingAPasskeyRemovalStopsItsQueuedChangesAtOnce` | Void the key's pending changes in `execute` when a `RemoveOwnerKey` is signed, before it queues. |
| F6b | Medium | Same as F6 for one agent: a queued bigger allowance later undoes the owner's instant cut. | `test_F6b_staleQueuedGrantMustNotUndoALaterCut` | As F6. |
| F9 | Guard | An address that was never an agent must not be able to void the owner's queued changes. Passes on v2; added to guard any generation counter (it fails on v3 in `build/4`, see below). | `test_F9_aStrangerCannotVoidTheOwnersQueuedUnfreeze` | Only a registered agent becoming frozen, the guardian or the owner may start a new generation. |
| F7 | Low | Owner and agent payment ids share one namespace. An agent that learns the id of a payment waiting for the owner (the approval link exposes the signed bytes, see G2) spends it first on a 1-unit payment; the owner's approved payment then reverts. | `test_F7_agentMustNotBeAbleToBurnAnOwnerPaymentId` | Separate namespaces, e.g. owner payments use `keccak256("owner", id)`. |

F1, F3 and F5 matter beyond the bug count: the payment association's agent-payment convention (August 2026) names the user's right to revoke authorisation as a requirement. A judge who tests "disconnect" should find that it is final.

### Gateway and approval link (`packages/domain/src/gateway.audit.test.ts`)

| # | Severity | What happens | Test | Suggested fix |
|---|---|---|---|---|
| G1 | High | On any wallet without a live vault (every new account and every demo sandbox until a passkey is enrolled), `propose_payment` returns the approval URL to the agent. Its token is a bearer credential and `approvals:decide` needs no sign-in, so **the agent approves its own over-limit payment**. | `G1: an assistant cannot approve its own over-limit payment` | `decide` requires the signed-in owner for tasks without a passkey action. Don't hand agents a usable approval token: return the task id, and deliver the link on the owner's own channel. |
| G2 | Medium | The same token opens `approvals:get`, a public query. It returns the vault balance and the address of every saved contact and agent, even for an assistant set to "hide balances" whose `list_contacts` deliberately omits addresses. | `G2: the approval link doesn't reveal hidden balances or contact addresses` | Return only the decoded fields of this task's signed bytes and the names for addresses that appear in them. Drop `wallet.balanceMinor`. |
| G6 | Medium | requestId de-duplication is per agent. Two assistants handed the same invoice both pay it. (Raised by the Codex review as a gap; reproduced here.) | `G6: the same invoice from two assistants is paid once` | Wallet-wide obligation key (payee + requestId, or an invoice hash), checked across agents and channels. |
| G3 | Low | With balances hidden, `can_afford` still answers yes/no; bisection pins the hidden "safe to spend" figure to the cent in 36 calls (the limit is 60 a minute). | `G3: can_afford can't be bisected into the exact hidden balance` | When balances are hidden, answer in coarse bands with a margin, and budget the calls per day. |
| G5 | Low | A payment the vault will hold is returned as `outcome: "paid"`. Structured clients read the field, not the message. (Codex review.) | `G5: a held payment isn't reported as paid` | `accepted` / `held` / `submitted` / `confirmed`; `paid` only after the receipt. |
| G4 | Low | `amount: 0.004` rounds to 0 cents, passes every check and goes on-chain as a $0 `agentPay`. The vault refuses it and counts a strike; five freeze the agent. | `G4: a sub-cent amount is refused before it reaches the chain` | Refuse when the rounded amount is below one cent. |

### Ledger and parsing (Codex review, still reproducing)

From `packages/domain/src/audit-review.test.ts` in the review checkout: unrelated same-amount purchases in a bank and a payment app merge as duplicates; unrelated income and spending become an own-account transfer; two coffees entered separately on one day collapse into one; a UPI handoff is marked confirmed without settlement evidence; a receipt total `1250.00` parses as `125`; `12,50` parses as `1250`.

### Deployment and evidence

| Item | Severity | Detail |
|---|---|---|
| Dashboard has no CSP or frame protection | Low | `agent-wallet-nu.vercel.app` sends only HSTS. Money needs the passkey on the separate approval site, but freeze, disconnect and limit screens can be framed. Add `frame-ancestors 'none'` and a CSP in `next.config.ts` headers. |
| Race evidence links point at holds | Low | `evals/README.md` says "two paid" and links `0x5ad0b560…` and `0x1ee6ff87…`. Both are `PaymentHeld` ($6 is above the $5 hold). They were released 64 blocks later in `0xbd74ac20e2b5796f61f359f9ff9385b17846b6417544a6a56f7a1d910d72f3da` and `0x3e85527eff8614900bf9c2295de4674f139daf060c124a53ee7dec88b38a6ec6`. Cite both. |
| `forge test` appends to the committed CSV | Low | `AttacksTest` appends rows to `evals/results/contract-attacks.csv`; only the script writes the header. A plain `forge test` leaves the file with every row twice. Write the header in `setUp` or only from the script. |

Live probes (read-only, 16 Oct): the approval site sends a strict CSP, `X-Frame-Options: DENY`, `no-referrer`, HSTS with preload and a locked-down permissions policy. `/mcp` returns 401 without a key or with a wrong key and 405 on GET. `/telegram` returns 403 without the secret or with a wrong one.

## Retest on the build branches (16 Oct, 02:30 IST)

Same tests, run against the fixes in progress. Posted on the issues.

| Branch | Result |
|---|---|
| `build/4` @ `925bba8` (contract v3, #4) | 125 pass, 6 fail. F1–F5 fixed; hold-aware invariants pass. Still open: F5b, F6, F6b, F7, F8. **F9 fails, new in v3:** `freezeAgent` accepts `msg.sender == agent` and every freeze starts a new generation, so any address can void every queued owner change, including the vault's own unfreeze. Needs fixing before deploy. Tests needed two encoding updates for v3 (`AddContact` cap, six-field `held()`); no assertion changed. |
| `build/6` @ `5eedfff` (approval tokens, #6) | 15 pass, 4 fail. G1 and G2 fixed; all 13 controls hold; its own backend tests pass 5/5. Open: G3, G6 (#7), G4, G5 (#9). |

## Not covered

- Prompt injection with a real model. `agent.eval.test.ts` is written (seven attacks, six legitimate tasks) but needs `ANTHROPIC_API_KEY` locally and on the dev deployment. Its scoring also needs repair before results are published: it never calls `liveVault()`, so payments settle on the simulator, and benign failures don't fail the test (Codex review, point 4).
- Two real signed-in users side by side; Clerk and demo-token isolation on the deployment.
- Phone passkeys on iOS; Telegram link previews; external MCP clients other than Claude Code.
- Load beyond the 60-a-minute MCP limit; Convex function limits under a large import.

## Rerun everything

```bash
pnpm install
cd contracts && forge build && forge test --no-match-contract AuditFindings   # green baseline, 59 tests
forge test --match-contract AuditFindings                                     # F1–F9, red until fixed
cd .. && pnpm typecheck
pnpm --filter @agent-wallet/domain exec vitest run                            # unit + gateway audit (G1–G6 red until fixed)
EVIDENCE_RPC=https://sepolia.base.org pnpm --filter @agent-wallet/domain exec vitest run evidence.e2e
```

For the local-chain passkey test: `anvil --chain-id 84532 --port 8546`, deploy with `forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8546 --broadcast` and Anvil's first key as `RELAYER_PRIVATE_KEY`, then `ANVIL_URL=http://127.0.0.1:8546 TOKEN=… FACTORY=… vitest run vault.int`.

## Files added by this review

- `contracts/test/AuditFindings.t.sol`: F1–F9 as requirements.
- `contracts/test/AuditInvariant.t.sol`: stateful fuzzing with holds, releases, cancels, freezes and a stolen key.
- `packages/domain/src/gateway.audit.test.ts`: 13 gateway controls and G1–G6, against an in-memory database.
- `packages/domain/src/evidence.e2e.test.ts`: checks every cited transaction on Base Sepolia and compares deployed bytecode with the source. Writes `evals/results/onchain-evidence.csv`.
