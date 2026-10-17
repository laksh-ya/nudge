# Deck outline (10 minutes)

Slide by slide with speaker notes. About one minute per slide; the live loop gets two. Judges include bankers, AI and federated-learning researchers and a finance econometrician: lead with the guarantee and the evidence, keep the cryptography to one slide.

## 1. Title (0:00)
**Nudge: let any AI pay, within rules it can't break.** Team, Topic F, WeBank FinTechathon 2026.

## 2. The problem (0:30)
- Assistants now read our email, bills and messages, and are being given the power to pay.
- Today an assistant that can pay holds a full key (hot wallet) or sits behind server-side limits a stolen key or a hacked server ignores.
- Prompt injection: any text it reads can carry an order. No model refuses every one.
- **User-value number:** with a stolen agent key and our server bypassed, a hot wallet lost **$242** of $250 in our tests; Nudge sent **$0** to the attacker. (`evals/README.md`, same attacks against all three designs.)

## 3. The product (1:30)
- A personal finance app (accounts, bills, safe-to-spend) with an **Nudge wallet**.
- Any assistant connects: our own chat and Telegram, and outside assistants such as Claude over MCP, each with its own key and limits.
- Three tiers: small payments go at once; above $5 they're held 2 minutes so you can cancel; above the assistant's limits you approve with your phone's passkey.

## 4. Live loop (2:30, two minutes)
Run or play the video segment: Claude pays $3 → $8 held and cancelled → $12 approved on the phone → stolen key refused on the explorer → "freeze" in chat. Every step is a Base Sepolia transaction.

## 5. How it works (4:30)
One diagram: assistant → MCP gateway (checks first) → relayer → **PolicyVault** (checks again, on-chain) ← owner's passkey via the approval site.
- The contract is the final gate: saved contacts only, per-payment and rolling 24-hour limits, a wallet ceiling, a protected amount agents can never touch.
- Loosening any rule needs the passkey and waits; tightening is instant.
- No admin key, no upgrade path; our own key can only freeze and cancel.

## 6. Security claims, each with evidence (5:30)
| Claim | Evidence |
|---|---|
| A stolen key can't pay a new address, exceed limits or replay | Refusals 2010 / 2003 / 2007 on Base Sepolia; `forge test` |
| Revocation is final | 13 invariants, each over 128 random sequences of up to 16,384 calls; review findings F1–F9 fixed |
| Approvals can't be forged or swapped | Passkey verified on-chain over the exact bytes |
| Nothing pays twice after a lost reply | Fault-injection tests; Base Sepolia lost-receipt run |
| Every number we cite is on-chain | `scripts/verify-evidence.sh`: 82/82 rows match |

## 7. Attack results (6:30)
- **Prompt injection, 38 attacks** (12 hidden in the owner's own bills, contacts, categories): Claude Opus, Sonnet, Haiku over MCP fooled **0 of 38**.
- **Model scripted to obey every attack:** fooled 36 times, yet **$0** went to anyone not a saved contact; worst case $24.95, inside the published limits.
- **68 P0 attacks from our corpus:** 63 automated, 19 with a Base Sepolia transaction (`evals/P0.md`).
- Honest limit: a fooled assistant can still pay a saved contact inside its limits. We publish that bound instead of claiming "injection-proof".

## 8. Compared with other entries (7:30)
Of the public Topic F entries we read: most have one built-in agent, test with scripted or mock models, and publish pass counts. We let **outside assistants** in through their own door, test with **real models over MCP**, bound the loss **in the contract**, and publish **per-attack on-chain transactions** with a script that checks them.

## 9. Compliance (8:15)
- Testnet and a worthless test token; no stablecoin delivered to anyone (consistent with 银发〔2026〕42号).
- Mirrors the CPCA agent-payment convention (Aug 2026): know-your-agent per key, signed authorisation boundaries, instant revocation, tiered limits, fallback and emergency freeze, published self-assessment. Production: a licensed partner holds accounts and the guardian role. (`docs/submission/COMPLIANCE.md`)

## 10. What's new (8:45)
- **Mandates anyone can check:** each assistant's authority is an AP2 IntentMandate, and every payment a PaymentMandate. A merchant's agent verifies them on Base Sepolia itself; the contract that enforces the mandate is the proof, not a network or our server.
- **A family guardian:** a daughter can stop her father's held payment from her own phone. She can only stop things, never move money.
- **Any AI, one guardrail:** Claude Code and Hermes (GLM-5.3) paid from one vault under one ceiling.

## 11. Roadmap (9:10)
Separate signer service; MCP OAuth with a consent page; family co-signing for elderly users and minors; bills as capped permissions; a licensed rail (bank account or e-CNY) under the same vault rules.

## 12. Close (9:40)
"Let any AI pay, inside rules it can't break, with every step on-chain for anyone to check." Links: live app, repo, evidence script.
