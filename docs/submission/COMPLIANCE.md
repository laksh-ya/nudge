# Compliance map

Draft laid out for the official template. We are students with no licence and no legal entity. This is a **testnet prototype with a valueless test token**: nothing here moves real money, and nothing is offered to the public as a payment service. The map shows how the design **mirrors** the rules a licensed operator would have to meet, so that a bank such as WeBank could run it as its own service. It is not a claim of compliance.

## 1. What the prototype is, legally

| Fact | Consequence |
|---|---|
| Base Sepolia testnet only; token `tUSD` with no value, mintable by anyone | No real funds, no custody of value, no settlement of real payments |
| No CNY, e-CNY or fiat-backed token; no stablecoin delivered to anyone | Outside the activities 银发〔2026〕42号 bars (see 3) |
| Each person's vault is their own contract; we hold no key that can move their money | Our guardian key can only freeze and cancel; agent keys are capped by the contract |
| Personal finance data is sample data or what a user imports into their own account | No connection to real bank accounts in the demo |

In production, accounts, transaction processing and settlement would sit with a licensed institution, as the convention below requires; the vault would be that institution's control layer, not a replacement for it.

## 2. CPCA convention on agent payment applications (《智能体支付应用自律公约》, 24 Aug 2026)

Issued by the Payment & Clearing Association of China under the People's Bank of China's guidance, for member institutions. Public reports (Xinhua, 21st Century Business Herald) describe the provisions below; article numbers are to be checked against the official text before submission.

| Convention provision (as reported) | How the design mirrors it | Evidence |
|---|---|---|
| Whoever provides the payment service is responsible (谁提供支付服务谁负责); liability with the licensed provider | Every action is attributable: agent payments carry the agent's own key and a payment id; owner actions carry the owner's passkey signature; refusals are on-chain events. In production the licensed operator holds the guardian role and the liability | `PaymentExecuted` / `PaymentRefused` / `OwnerPaid` events; README evidence tables |
| Know your agent (了解你的智能体, KYA), built on KYC | Each assistant is registered individually: its own vault key, its own MCP key, its own limits and expiry, visible to the owner; outside assistants are identified per key | `SetAgent` grants on-chain; agents page; `matrix.test.ts` scope cases |
| Clear authorisation boundaries in an agreement with the user | The authorisation is the signed `SetAgent` grant itself: per-payment limit, 24-hour cap, expiry, saved contacts only; the owner signs it with a passkey over the exact bytes | Approval site renders the grant from its bytes; `approval-truth.test.ts` |
| Verify the user's payment intent | Inside limits the owner's standing grant is the intent; above limits, a passkey signature over the exact payment; the rule-based chat pays alone only on a direct order | `chat-pay.test.ts`, `gateway.audit.test.ts` |
| Users can revoke authorisation (and close the service) | Freeze any assistant or the whole wallet from chat, Telegram or the app, at once; disconnect removes the agent's key from the vault; revocation voids anything queued for that agent | `test_revocationVoidsAnOlderQueuedGrant`, `invariant_noAgentMoneyWhileFrozenOrRemoved`; README "Disconnected agent's key removed from the vault" |
| Tiered, classified risk management; transaction limits (交易限额) | Three tiers enforced by the contract: pay at once (small), hold with a cancel window (above $5), owner passkey (above the assistant's limits); plus a wallet ceiling and a protected amount agents can never touch | `PolicyVault.agentPay` checks; 13 invariants |
| Caution for the elderly and minors; keep manual service and alternatives | Owner sets smaller limits and longer holds per assistant; every agent payment can also be made by the owner directly; family co-signing is planned (#16) | Limits per agent; owner pay from the app |
| Report and assess before agent-initiated (autonomous) payments; safety testing | Our own assessment and tests are published: security self-assessment, attack corpus coverage, red-team evals with real models | `SELF-ASSESSMENT.md`, `evals/P0.md`, `evals/README.md` |
| Human service, risk monitoring, emergency response, fallback (回退机制) | Emergency: instant freeze from any channel; fallback: holds can be cancelled, queued loosening can be cancelled; monitoring: every vault event is shown on the proof page and as activity | Proof page (`/proof`); `test_ownerCancelsAHeldPayment`, `test_guardianCancelsAQueuedLoosening` |
| Fair ecosystem: no exclusive dealing, forced bundling or subsidies to restrict choice | Any MCP-capable assistant can connect with its own key; nothing ties the user to one model vendor | MCP gateway; eval runs three Claude models through the same door |
| Algorithms must not discriminate or over-induce consumption | The assistant only acts on the owner's request and reports amounts from tools, never invents them | Eval `answer` cases; amounts only from tool results |

Stages: the convention distinguishes assisted payment from autonomous payment under preset conditions. The prototype stays within preset conditions (the owner's signed grant); it never lets an assistant set or widen its own conditions.

## 3. 银发〔2026〕42号 (People's Bank of China, 6 Feb 2026)

Bars financial institutions and non-bank payment institutions from providing services for virtual-currency fund movement, stablecoins included.

| Requirement | Our position |
|---|---|
| No virtual-currency or stablecoin fund movement through financial or payment institutions | The prototype runs on a public testnet with a worthless test token; it moves no real value and serves no customer. A production version for the mainland would settle through the licensed rail (bank accounts, e-CNY), with the vault as the policy and evidence layer, not through a stablecoin |
| No stablecoin delivery to mainland consumers | None: we issue no stablecoin and deliver none |

## 4. Personal data

| Principle (PIPL) | Design |
|---|---|
| Minimum necessary | Outside assistants see only what the owner allows; balances can be hidden per assistant; the approval page shows only the action |
| No sensitive data on-chain | The payment purpose is stored on-chain only as a hash of the task id and text; no names or amounts beyond the payment itself |
| Isolation | Each user and each demo visitor has a separate account; tested in `review.test.ts` (foreign data controls) |

## 5. What we would need before real money

A licensed partner holding the accounts and the guardian role; an external contract audit; KYC of users and a registry of agent vendors (KYA); filing with the association before autonomous payments; device-bound passkeys and a recovery process; a separate signer service for agent keys.
