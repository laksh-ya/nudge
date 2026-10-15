# agent-wallet (working name)

A testnet wallet that lets AI agents pay saved contacts within owner-set limits. The vault contract enforces those limits even if an agent's key is stolen. Anything larger, and any change that loosens a rule, needs the owner's passkey signature over the exact action, and loosening then waits out a delay the owner can cancel. Around it sits a personal-finance app (dashboard, imports, bills) with its own assistant. Bank feeds, family transfers and some demo history are simulated.

Entry for FinTechathon 2026, Topic F (Agent Wallet). Product spec: `reports/Full product plan.md` in the research workspace. This file is the stack decision record that Claude and Codex both follow; change a row here instead of writing a second architecture.

## What is live and what is simulated

| Area | State |
|---|---|
| Vault payments (agent within limits, held, owner-approved, refused) | Live on Base Sepolia, test token tUSD (no value) |
| Passkey approval and enrolment | Live: browser WebAuthn on the approval site, verified by the contract |
| Freeze, unfreeze, disconnect, limit changes | Live: every route acts on the vault and is confirmed by reading it back |
| Claude and other assistants over MCP | Live: JSON-RPC over HTTP with per-assistant bearer keys (OAuth not yet) |
| Built-in assistant | Rule-based replies; no language model inside the app yet |
| Bank feeds | Sandbox data per country; statement import (CSV, Excel, PDF, receipts) is real |
| Family transfers and quotes | Simulated |
| UPI | Hands the payment to your UPI app; no bank settlement confirmation |
| Telegram | Adapter built (one-use linking codes, re-link confirmation, update de-duplication); no bot linked in the demo |
| WhatsApp | Not built |

"Protected" means protected from agents: an owner's own Withdraw (delayed) can go below it; an owner-approved payment cannot.

## Stack

| Layer | In use | Version | Why |
|---|---|---|---|
| Language | TypeScript (strict) everywhere off-chain | 5.9 | One set of types for web, backend, approval site and tests |
| Monorepo | pnpm workspaces + Turborepo | turbo 2.11 | Separate deployables, shared packages |
| Dashboard | Next.js App Router, Tailwind | next 16.4, tailwind 4.3 | Main product UI |
| Approval site | Separate Vite + React static app on its own host and passkey RP ID; no analytics; strict CSP | vite 8.3 | The only place owner signing happens |
| Backend | Convex: schema, queries, mutations, scheduler, crons, HTTP actions | convex 1.46 | Mutations are transactions; a scheduled job commits with its state change |
| Relayer queue | Convex Workpool, one transaction at a time | @convex-dev/workpool 0.4.12 | No two sends share a nonce |
| App login | Clerk (`convex` JWT template); demo visitors get their own sandbox via a signed token | @clerk/nextjs 7.9 | Normal sign-in never authorises money |
| Payment passkey | Browser WebAuthn (no library) on the approval site; P-256 key verified by the vault | – | Separate from login |
| Outside agents | Hand-written MCP JSON-RPC at `/mcp`, bearer key per assistant, 60 calls/min | – | Small surface; OAuth per client is planned |
| Agent keys | One per agent, AES-256-GCM sealed under `AGENT_KEY_SECRET` | – | A database copy alone yields no key; the contract caps any one key |
| Contracts | Solidity 0.8.30, Foundry, OpenZeppelin WebAuthn/P256 | OZ 5.6.1 | Fuzz and invariant tests; P-256 precompile on Base Sepolia |
| Chain client | viem | 2.57 | Typed calls, receipts, event decoding |
| Chain | Base Sepolia (84532) | – | Testnet prototype |
| Tests | forge test, Vitest (unit, local-chain, Base Sepolia end to end) | – | Contract, encoding and full-path suites |

Planned, not in the code: an LLM-backed assistant, OAuth for MCP clients, WhatsApp, object storage for files, structured log redaction and an audit table, Playwright journeys.

## Not using

| Rejected | Reason |
|---|---|
| Privy, Dynamic, thirdweb, Turnkey embedded wallets | Owner signing key must stay with the owner and be verified by our contract, not held by a vendor |
| Clerk passkeys as payment approval | Clerk handles sign-in only. Payment approval uses a separate passkey on the approval site |
| Redis/BullMQ, Temporal, Inngest, Vercel Workflow | Convex mutations plus its scheduler already give transactional jobs |
| LangChain, LangGraph, CrewAI | Agent loop is small; money decisions are plain code, not framework |
| Next.js server actions for money operations | Chat, MCP and dashboard must share one API path |
| ethers.js, Hardhat | viem and Foundry instead |
| wagmi/RainbowKit wallet-connect onboarding | Consumers sign with a passkey, not MetaMask (optional second key later) |
| ERC-4337, paymasters, Safe, EIP-7702 in the first version | Vault verifies signatures itself; smaller security core. 4337 is later polish |
| Telegram Mini App or in-app browser for approval | Passkeys fail in Telegram's web view; approvals open in Safari/Chrome |
| Baileys, whatsapp-web.js | Against WhatsApp terms; account bans |
| Upgradeable proxy with an admin key | Admin could silently change spending rules |
| Floats for money, `block.timestamp / 1 days` caps | Rounding errors; double spend at midnight |
| Mainnet, FISCO BCOS as main chain | Testnet prototype; FISCO only as optional anchor |

## Layout

```text
apps/web          dashboard and onboarding (Next.js, Clerk, Convex)
apps/approve      approval site (Vite, separate host)
packages/backend  Convex: ledger, imports, sandbox feeds, crypto reads, rates, MCP gateway, Telegram
packages/domain   money, currencies, directory of banks/apps/chains, statement parsing (tested)
```

Still to add: a separate signer service for agent keys, an independent watcher for alerts, `evals/`.

## Connect an outside assistant (MCP)

Agents screen → Connect → copy the key (shown once). Then, for Claude Code:

```bash
claude mcp add --transport http agent-wallet https://ceaseless-raven-960.convex.site/mcp --header "Authorization: Bearer aw_…"
```

Tools: `get_overview`, `can_afford`, `list_bills`, `spending_this_month`, `list_contacts`, `propose_payment`, `get_task_status`, `cancel_task`. `convex/gateway.ts` decides pay, ask or refuse in code (per-payment and daily limits, wallet ceiling, protected amount, new contacts, freeze).

## On-chain (Base Sepolia)

| Contract | Address |
|---|---|
| VaultFactory | [`0x223c60BAa1C2EfCD0F95B0D73e51D6De9460Baa9`](https://sepolia.basescan.org/address/0x223c60BAa1C2EfCD0F95B0D73e51D6De9460Baa9) |
| TestUSD (tUSD, 6 decimals) | [`0xB0ee01235A8e7903519B029c1530332f5847D932`](https://sepolia.basescan.org/address/0xB0ee01235A8e7903519B029c1530332f5847D932) |
| Example vault | [`0xC6299CFc10366cBD576AFFc13a6f0440413d3510`](https://sepolia.basescan.org/address/0xC6299CFc10366cBD576AFFc13a6f0440413d3510) |

One run of `packages/domain/src/onchain.e2e.test.ts` through the real backend (passkey assertions from a software P-256 key shaped like a browser's):

| Step | Who signs | Transaction |
|---|---|---|
| Vault deployed for the passkey | relayer | [`0xd2056b73…`](https://sepolia.basescan.org/tx/0xd2056b7302cdbd68a40d40be9b47a72887a9f5177b20a07016d35c1221f3ff3e) |
| Setup: 2 agents and 6 contacts in one approval | passkey | [`0x089acf28…`](https://sepolia.basescan.org/tx/0x089acf28e2a84fa0dfc0497cdffa6cc4c4c10b33a887532575b094eb2091db25) |
| Claude pays Blue Tokai $8 within its limits | Claude's agent key | [`0xde9860d4…`](https://sepolia.basescan.org/tx/0xde9860d4c13782b76ae2532001dd75447025eb131b2e2e25c28c4f3f338a326b) |
| Claude asks for $18, over its limit; owner approves | passkey | [`0xb7272497…`](https://sepolia.basescan.org/tx/0xb7272497d2e05893a692decdfdbafc13cb3f165f2b13536f44ecce98962e60f1) |
| Stolen agent key tries $50: refused, code 2003 | agent key, bypassing our server | [`0xe404d5f3…`](https://sepolia.basescan.org/tx/0xe404d5f31ed429ef92a2bba13e5fc998d787631f96be9024fa3e58b9a1042cb4) |
| Stolen key replays the $8 payment: refused, code 2007 | agent key | [`0xb2c2e268…`](https://sepolia.basescan.org/tx/0xb2c2e2688c9d51e2c806f7db8698de39da993c96eddea5ddab7bbc47b90ec8f5) |
| Stolen key pays an unknown address: refused, code 2010 | agent key | [`0xeaa83ddf…`](https://sepolia.basescan.org/tx/0xeaa83ddf0b52937c27ce0331bf23cbfdff1526aa3e0ad9d75ad715b73dc956df) |
| Guardian freezes Claude in the vault | relayer (can only tighten) | [`0x676a0fc2…`](https://sepolia.basescan.org/tx/0x676a0fc216a827a04f2102aae61f8aec54ea124883974c847ed23bb11e5b7a4e) |
| Owner unfreezes Claude | passkey | [`0x8e27c5a2…`](https://sepolia.basescan.org/tx/0x8e27c5a2fb9e57142c21d09ead9fd25b40acbfb730c02150ec94385b2f91e12a) |

On the live app with a passkey on a real phone, vault [`0xd71b81a1…`](https://sepolia.basescan.org/address/0xd71b81a157Ce1D4651D2B1CF0CCb59bea789Ae40):

| Step | Who signs | Transaction |
|---|---|---|
| Setup: agents and contacts in one approval | phone passkey | [`0xbebb2061…`](https://sepolia.basescan.org/tx/0xbebb20616a80f3e49f175a46f53ec1d6596d2b02913457bc5f1a224b64abd7c5) |
| Claude pays Blue Tokai $8 over MCP, within its limits | Claude's agent key | [`0x4bc75942…`](https://sepolia.basescan.org/tx/0x4bc75942fb9e9498c64f504932486966975d29047d2e7aedc05cd6bbba70e774) |
| Claude asks for $18, over its limit; owner approves on the phone | phone passkey | [`0x8f32ad0b…`](https://sepolia.basescan.org/tx/0x8f32ad0ba0bfdc65a1c8625b2fb5365edbd36c949a55983c9b3042eb8a3d8d47) |

Deploy your own: put `RELAYER_PRIVATE_KEY` and `RELAYER_ADDRESS` in `contracts/.env`, fund the address with Base Sepolia ETH (0.0001 covers the contracts and a few vaults), then run `contracts/deploy.sh`. It deploys both contracts and points the Convex deployments at them.

Tests:

```bash
cd contracts && forge test                         # 30 tests, fuzz and invariants
pnpm --filter @agent-wallet/domain exec vitest run # encoding, digest, statements
E2E_CONVEX_URL=https://<dev>.convex.cloud pnpm --filter @agent-wallet/domain exec vitest run onchain.e2e
```

The last one resets the demo account on that deployment and spends about 0.00003 ETH of relayer gas; it reuses its vault on later runs.

## Turn on Telegram

Create a bot with @BotFather, then:

```bash
npx convex env set --prod TELEGRAM_BOT_TOKEN <token>
npx convex env set --prod TELEGRAM_WEBHOOK_SECRET <random string>
npx convex env set --prod TELEGRAM_BOT_USERNAME <bot username without @>
npx convex run --prod telegram:setWebhook
```

## Run locally

```bash
pnpm install
pnpm --dir packages/backend dev     # Convex dev deployment
pnpm --dir apps/web dev             # http://localhost:3000
pnpm --dir apps/approve dev         # http://localhost:3001
```

Env files (not committed): `apps/web/.env.local` needs `NEXT_PUBLIC_CONVEX_URL`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_APPROVE_URL`. `apps/approve/.env.local` needs `VITE_CONVEX_URL`, `VITE_WEB_URL`. The Convex deployment needs `CLERK_JWT_ISSUER_DOMAIN`, and `DEMO_MODE=true` to allow the shared demo account.

Reset the demo account: `npx convex run demo:reset` (add `--prod` for production).

## Open decisions

- Product name (kept in `apps/web/lib/config.ts`).
- Clerk app is a temporary development instance; claim it into a Clerk account before real users.
- Demo token: our mintable tUSD now; Circle test USDC later as well.
- Hosting accounts (Vercel, Neon, container host) versus local Docker first.
- Whether organisers accept testnet hashes.
