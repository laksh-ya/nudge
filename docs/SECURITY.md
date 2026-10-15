# Security self-assessment

Testnet prototype on Base Sepolia with a valueless test token (tUSD). This is the team's own assessment, not an audit. Every claim below points at a test or a transaction; anything without evidence is listed as a known risk.

## The claim

An agent can only pay saved contacts, inside per-payment, rolling 24-hour and wallet-wide limits that the vault contract enforces itself, and never into the amount protected from agents. That holds even if the agent's key is stolen and our server is bypassed. Anything beyond those limits, and every change that loosens them, needs the owner's passkey signature over the exact action; loosening then waits a delay the owner can cancel.

We do not claim resistance to prompt injection as such. A tricked agent can still make a bad payment that fits its limits; the limits bound how much.

## Who can do what

| Role | Can | Cannot |
|---|---|---|
| Owner passkey (one or more, made on the approval site) | Pay any amount that leaves the protected amount; add or remove agents and contacts; change limits; unfreeze; add or remove passkeys; withdraw (the only way below the protected amount, and delayed) | Act without user verification (Face ID, fingerprint or PIN); act on another vault; reuse a signature (nonce and deadline are signed) |
| Agent key (one per agent) | `agentPay` to a saved contact within its limits; freeze itself | Call anything else; pay a new address; exceed per-payment, 24-hour, wallet ceiling or protected amount; replay a payment id; unfreeze itself |
| Guardian (our relayer key) | Freeze the vault or an agent; cancel a held payment or a queued change; submit what the owner signed; deploy vaults | Move money; add agents or contacts; loosen any rule; forge or alter an owner signature |
| Backend (Convex) | Decide pay, ask or refuse before anything reaches the chain; hold sealed agent keys; relay | Exceed what the contract allows with any key it holds |
| Outside assistant (MCP bearer key) | Read what the owner allows; propose payments; ask for approval | Hold any wallet key; approve anything; bypass the gateway's checks |
| Demo visitor | Their own sandbox only (signed token, http-only cookie) | See or change anyone else's account; open the judge account without the judge key |

## Controls and evidence

| Control | Where | Evidence |
|---|---|---|
| Owner passkey verified on-chain, site pinned, user verification required, low-s | `PolicyVault.execute` | `test_passkeyFromAnotherSiteIsRejected`, `test_userVerificationIsRequired`, `test_tamperedActionIsRejected`, local-chain test with browser-shaped high-s signatures; phone-signed setup [`0xbebb2061…`](https://sepolia.basescan.org/tx/0xbebb20616a80f3e49f175a46f53ec1d6596d2b02913457bc5f1a224b64abd7c5) and payment [`0x8f32ad0b…`](https://sepolia.basescan.org/tx/0x8f32ad0ba0bfdc65a1c8625b2fb5365edbd36c949a55983c9b3042eb8a3d8d47) |
| Approval page shows decoded bytes and computes the challenge itself; agent's note is labelled unverified and sits outside the signed section | `apps/approve` | `vault.test.ts` digest pinned to the contract; describe tests |
| Rolling 24-hour limits, shared ceiling, payment-count cap | `_refusal`, ring buffers | `test_noMidnightDoubleSpend`, `test_sharedCeilingAcrossAgents`, invariant `rollingCeilingHolds`, fuzz `stolenKeyIsBounded` |
| Protected amount: agents never; owner payments never; only a delayed Withdraw | `_refusal`, `_applyOne(Pay)` | `test_ownerPaymentLeavesProtectedAmount`, invariant `protectedAmountHolds` |
| Refusals are successful transactions with a reason code | `PaymentRefused` | Stolen-key refusals 2003 / 2007 / 2010 on v1 ([`0xe404d5f3…`](https://sepolia.basescan.org/tx/0xe404d5f31ed429ef92a2bba13e5fc998d787631f96be9024fa3e58b9a1042cb4), [`0xb2c2e268…`](https://sepolia.basescan.org/tx/0xb2c2e2688c9d51e2c806f7db8698de39da993c96eddea5ddab7bbc47b90ec8f5), [`0xeaa83ddf…`](https://sepolia.basescan.org/tx/0xeaa83ddf0b52937c27ce0331bf23cbfdff1526aa3e0ad9d75ad715b73dc956df)) |
| Five refusals in 24 hours freeze that agent | `_strike` | `test_fiveRefusalsFreezeTheAgent`, `test_strikesFadeAfterAQuietDay` |
| Loosening waits a cancellable delay; tightening is instant | `execute` → `queued` → `finalize` | `test_looseningWaitsAndTighteningIsInstant`, `test_guardianCancelsAQueuedLoosening`, `test_frozenVaultOnlyLetsUnfreezeApply`; on Base Sepolia: unfreeze queued [`0xb294948d…`](https://sepolia.basescan.org/tx/0xb294948d8772c99b06ef2cccdcae88fa06b7661073d97f2dd33d943910f41e41), applied after the delay [`0x0fea72e1…`](https://sepolia.basescan.org/tx/0x0fea72e1b5d49132d44820f0e917e28d7b3d5df95a88cfad7c0d7dcf4c457866) |
| Large agent payments held and cancellable; frozen or changed contact blocks release | `agentPay` → `release` / `cancelHeld` | `test_largeAgentPaymentWaitsThenReleases`, `test_ownerCancelsAHeldPayment`, `test_freezeOrRemovedContactBlocksRelease`, `test_heldMoneyCountsAgainstProtected` |
| Changing limits never unfreezes | `SetAgent` | `test_changingLimitsDoesNotUnfreeze` |
| Every freeze, disconnect and limit change acts on the vault, from every route | `convex/lib/control.ts` | End-to-end: chat "freeze" confirmed by reading the vault, then the old key reverts `AgentFrozen`; disconnect removes the key [`0xf2b60e21…`](https://sepolia.basescan.org/tx/0xf2b60e21ca1a36bcec1a2ddd308a207127b57e9a87fd9cfc5414d3cfe6f5c823) |
| Freeze shown as done only after reading the vault back | `guardianFreeze` | Agents screen shows "Freezing in vault…" until confirmed |
| Passkey enrolment: server challenge, origin, site hash, user verification and the key itself checked; counts only after the signed-in owner types the code the phone shows | `vault.completeEnrol`, `vault.confirmEnrol` | End-to-end: wrong challenge refused, used link refused, wrong code refused |
| Lost receipts are "unknown", reconciled by hash, never "failed" | `chain.receipt`, `chain.reconcile` | Code path; a forced-timeout test is still to do |
| Retries never pay twice: caller `requestId` maps to one on-chain payment id | `gateway.proposePayment`, `paymentIdFor` | End-to-end duplicate check (rerun pending, see below) |
| One serial queue for every transaction we send | Convex Workpool, parallelism 1 | Design; concurrency test still to do |
| Agent keys sealed (AES-256-GCM, bound to the agent id) | `lib/secrets.ts` | End-to-end checks stored keys start `enc:v1:` |
| Demo isolation: per-visitor sandboxes; judge account only with its key | `api/demo/token`, `auth.config.ts` | Manual check; two-browser test still to do |
| Rate limits: MCP 60/min per assistant; vault deployments 6/hour, sandbox 3/day; code entry 5 per 15 min | `lib/limits.ts` | Code |
| Telegram: one-use 10-minute linking codes, re-link needs the owner's yes, each update handled once | `telegram.inbound` | Code; no bot linked in the demo |

## Known risks

| Risk | Why it remains | What limits it |
|---|---|---|
| A malicious or compromised approval page shows one thing and asks the passkey to sign another | WebAuthn has no trusted display; the phone's sheet shows the site, not the payment | Separate origin, strict CSP, no third-party scripts, display rebuilt from the signed bytes; loosening waits a cancellable delay |
| A compromised backend holds the guardian key and sealed agent keys plus the secret that opens them | Keys and secret live in the same deployment for this prototype | Each agent key is capped by the contract; the guardian can only tighten; a dedicated signer service is the fix |
| Owner tricked into approving a bad payment | No software can judge intent | Exact amount and address shown; new contacts wait; protected amount still applies |
| An in-limit payment to a saved contact for the wrong reason | Limits bound amount, not purpose | Small default limits; holds above $5 give a cancel window |
| Losing every passkey locks the vault | No recovery path beyond backup passkeys | Backup passkeys supported and prompted; test funds only |
| Synced passkeys follow the platform account (iCloud, Google) | Passkeys may sync; the chain can't tell | Stated plainly; device-bound keys are a choice the owner can make |
| Held-payment cancel doesn't refund the 24-hour budget | Keeps the rolling window simple and conservative | Only reduces what agents can spend |
| Public RPC nodes lag a block | sepolia.base.org is load-balanced | Reads retried, re-read after each transaction, gas estimated only when the vault is visible |
| Unaudited contract | Prototype | 45 forge tests including fuzz and invariants; no admin or upgrade path |
| Strikes can be tripped deliberately to freeze an agent | Only that agent's own key can strike it | A stolen key freezing itself is the intended outcome |

## Not covered yet

- A forced receipt timeout plus worker restart, and two agents racing near the shared ceiling, as automated tests.
- Two real signed-in users side by side.
- The assistant inside the app is rule-based, so there is no model-in-the-loop injection evaluation yet.
- OAuth for MCP clients; WhatsApp.
