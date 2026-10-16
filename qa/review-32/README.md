# Independent verification — 16 October 2026

**Review disposition: NO-GO for deploying PR #43 at `a9d9ed7`.** The existing tests pass, but six added contract requirements fail. PR #45 at `77d2330` fixes the original 33 backend/finance probes; seven additional backend checks and one real local-EVM broadcast fault still fail. This is a review/test-only branch; it changes no product code or deployed state.

## Reproduce

Install the repository's pinned dependencies with pnpm and have Foundry (`forge`, `anvil`), Node and Python 3.12+ available. From the repository root:

```sh
python3 qa/review-32/run.py --ref 77d2330892b191bf53753985fb976d72a3fa7afe --broadcast
node qa/review-32/verify-published-evidence.mjs
```

The runner archives the selected commit into a temporary directory, links installed dependencies, copies the probes there, runs the original suites and the added probes, and writes a manifest and logs. It never loads `.env` files. `--broadcast` starts its own Anvil on port 18546 (fails safely if occupied), deploys local contracts, and stops the chain afterwards. The hard-coded key is Anvil's public development key, never a production secret. Exit 1 is expected on the reviewed commits because desired behavior fails. Test dependencies include the project's pinned convex-test 0.0.60 and Vitest 5.0.4.

Use `--ref <fix-commit>` to check a fix without modifying the builder's checkout. The source probes live outside normal test discovery intentionally: this PR preserves failing review evidence without silently breaking product CI. After fixes, integrate the relevant tests into the regular suites.

## Verified results

| Run | Result | Scope |
|---|---|---|
| PR #43 original Foundry suite | 122 pass | Includes inherited tests counted in multiple suites; not 122 unique threat models |
| Added v3 probes | 6 fail, 1 pass | Real EVM/P256 assertions; failures are desired requirements violated |
| PR #45 original backend/domain tests | 69 pass | Includes all original 23 backend + 10 finance probes, approval and contact tests |
| Added backend probes | 7 fail | Production handlers/schema in Convex's mock runtime; relayer scheduling mocked |
| Lost broadcast response | 1 fail | Production chain action + actual local Anvil transaction + fault-injecting RPC proxy |
| Published README evidence | 39/39 successful receipts | All unique transaction links in this pinned README; decoded event data saved |

The public-RPC verifier checks Base Sepolia chain ID and saves emitting contract addresses and decoded events. These receipts corroborate on-chain payments/refusals/holds. They do not prove which phone, Claude client or Telegram conversation initiated them. They do not prove v3 is deployed.

Earlier work at `680daf9` found 18 backend/finance failures and seven observed v2 contract failures. Do **not** repeat those as unresolved findings against #45: the original 33 backend/finance checks are green now, and v3 fixes the tested basic removal/expiry/protection/queued-state cases. The table below identifies the remaining gaps.

A second isolated run on `build/8` commit `2985cf7` reproduced the same six contract and eight backend/fault failures, with 74 existing backend/domain tests passing. The new `BroadcastError` prevents blind retry but its caller still records `failed`; it does not fix B1. Logs are under `evidence/build8-recheck/`.

## Implementation handoff: contract #4 / review #32

| ID | Priority and prerequisite | Reproduced behavior | Required implementation |
|---|---|---|---|
| C1 | P0 deployment blocker; any outsider, no owner key | `freezeAgent(attacker)` advances the global generation. An unrelated signed Withdraw becomes `Stale`. Repeating this can obstruct recovery/unfreeze indefinitely. Independently confirms test-lane F9. | Reject self-freeze by non-agents. Scope agent-triggered invalidation to that agent and to real transitions; preserve authorized guardian incident invalidation. An agent must not invalidate unrelated owner recovery. |
| C2 | P0 recovery blocker; attacker already has a usable owner passkey, owner has backup | Attacker queues 250 tUSD Withdraw. Backup signs key removal 30 seconds later. Withdrawal matures at 120s while removal waits until 150s; all 250 tUSD leave. Confirms previously reported F5b. | Immediately suspend/revoke the compromised key and invalidate its pending authorizations when authenticated revocation is accepted. Preserve the last-key rule and a usable backup. Key revocation must not wait behind the attack it is meant to stop. |
| C3 | P1; owner removes, regrants and unfreezes same agent key | A prior 8 tUSD hold releases after regrant. Current-active checks lose the history of revocation. | Store an agent grant generation on each hold; invalidate it permanently when that grant is revoked, independently of later grants. |
| C4 | P1; owner removes/re-adds same contact in same block, immediate activation | Old 8 tUSD hold releases because `activeAt == heldAt`. | Use a monotonic contact generation captured by the hold. Timestamps are not identity/version checks. |
| C5 | P1; existing mature and cooling aliases for same address, mature one removed | `_payeeSince` retains deleted alias's timestamp; owner Pay of 3 tUSD bypasses the wait despite remaining alias still cooling. Confirms test-lane observation with an executable test. | Maintain current active aliases correctly, recompute maturity on removal, or enforce one canonical contact per address. |
| C6 | P1; active agent key knows owner payment ID (public on-chain) | Owner pays invoice 3 tUSD; agent pays same ID another 3 tUSD. The new `ownerPaid` map is not checked in `_refusal`. | Agent path must reject IDs in either `ownerPaid` or `paymentUsed`. Preserve the fix that prevents an agent pre-consuming an ID from blocking the owner's authorized payment. |

The seventh contract probe (enable a 17 tUSD contact cap after 17 payments) passes; no failure is claimed for that scenario. Several findings have owner-action prerequisites and are not unauthenticated drains; C1 is unauthenticated denial of service, and C2 requires compromise of a usable passkey.

## Implementation handoff: backend and ledger

| ID | Priority | Reproduced behavior | Required implementation |
|---|---|---|---|
| B1 | P0 settlement truth | Proxy forwards `eth_sendRawTransaction`, Anvil mines successful 3 tUSD transfer, proxy loses the acknowledgement. Task becomes `failed`, stored hash null. | Prepare/sign the transaction and durably persist its hash, sender, nonce and logical intent before broadcasting. On ambiguous send outcome keep `unknown` with reservation intact; reconcile the same transaction. Only definitive pre-broadcast rejection or an observed revert is failure. Apply to owner/agent/finalize/release paths, not just receipt timeout. |
| B2 | P1 settlement truth | Success then retry-refusal callback downgrades `confirmed` to `failed`; late timeout downgrades it to `unknown`; repeated success creates two payment activity entries. These are internal callbacks, not public unauthenticated endpoints. | Enforce allowed task transitions and attempt/hash identity; deduplicate callback effects. Preserve authoritative success, reject stale outcomes and prevent terminal-task rebroadcast. Handle chain reorgs through an explicit reconciler, not arbitrary callback overwrite. |
| B3 | P1 ledger correctness | One bank Coffee charge matches both of two payment-app Coffee purchases an hour apart; only one remains counted. | Use one-to-one cross-source matching with stable transaction/source IDs where available; ambiguous matches need review rather than automatic exclusion. Keep actual repeated purchases. |
| B4 | P2 bounded totals | 501 active $1 obligations before payday produce $500 commitments and `partial:false`. | Count all obligations via indexed aggregates/pagination, or propagate an explicit incomplete flag and disable definitive safe-to-spend claims. Do not silently raise another limit. |
| B5 | P1 agent privacy | Agent B reads agent A's payment with no shared proposal solely because the task has any requestId. Requires knowing a same-wallet task ID; this is not cross-user access. | Record which agents actually share an obligation, require relevant scopes and owner visibility policy, and authorize against those participants. Task-ID possession alone is insufficient. |
| B6 | P2 idempotency correctness | Same requestId with changed amount ($3 -> $7) returns the previous task as an ordinary duplicate. | Bind idempotency keys to normalized wallet/payee/amount/currency/obligation terms and return an explicit conflict on mismatch. Shared invoice identity should be trusted/canonical, not guessed by each model. |

## Limits and context

Both Claude sessions, the research knowledge base, issue #38 protocol, status #39, agent room #40 and builder/test-lane handoffs were read. Work here is verification, with implementation assigned to the builder. The other agent's Claude injection results in #47/#49 were read but were not independently rerun here; no claim of a fresh model evaluation is made.

Browser checks reached the local landing page, private visitor demo and Money page, including a 390px viewport with no horizontal overflow on the Money page. Broader scripted navigation did not complete reliably; it is not counted as a full judge walkthrough. Phone hardware, production Clerk flows, Telegram delivery, a funded v3 testnet deployment and load tests are not established by this review. Local tests do not mutate the judge account or send Telegram messages.

The 79-item original comparison census is not 79 eligible direct rivals. No maximum innovation score or best-in-field claim is supported. Prioritize correctness and a defensible proof/exposure page (#18) before adding more channels; present the demonstrated guarantees and their limits.
