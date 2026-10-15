# agent-wallet (working name)

A personal-finance app with its own assistant, a dashboard, and a wallet that lets AI agents spend within limits the owner sets. People use it on the web, through Telegram (then WhatsApp), or through an outside assistant over MCP. Every surface shares one account, one ledger, one task list and one payment lifecycle.

Entry for FinTechathon 2026, Topic F (Agent Wallet). Product spec: `reports/Full product plan.md` in the research workspace. Team architecture reference: `PactVault/docs/03-architecture.md` and `06-decisions.md`.

The interface is built against Convex with sample data. Payments are simulated; passkey signing and the wallet contract come next. This file is the stack decision record that Claude and Codex both follow; change a row here instead of writing a second architecture.

## Stack

| Layer | Use | Version checked 14 Oct 2026 | Why |
|---|---|---|---|
| Language | TypeScript (strict) everywhere off-chain | – | One set of schemas for web, API, tools, workers |
| Monorepo | pnpm workspaces + Turborepo | turbo 2.11 | Separate deployables, shared packages |
| Shared schemas | Zod | 4.6 | One definition feeds REST, MCP and assistant tools |
| Dashboard | Next.js App Router, Tailwind, shadcn/ui, installable PWA | next 16.4, tailwind 4.3 | Main product UI |
| Approval site | Separate Vite + React static app on its own host and passkey RP ID; no analytics; strict CSP | vite 8.3 | The only place owner signing happens; a hacked backend or dashboard can't alter it |
| Backend | Convex: schema, queries, mutations, scheduler, HTTP actions for chat webhooks | convex 1.46 | Live queries make every screen update instantly; mutations are transactions |
| App login | Clerk, connected to Convex through a `convex` JWT template | @clerk/nextjs 7.9 | Normal sign-in. It never authorises money |
| Payment passkey | SimpleWebAuthn on the approval site; P-256 public key stored on the vault | @simplewebauthn 14.0 | Separate from login, so recovering email can't replace the wallet owner |
| Outside agents | Official MCP TypeScript SDK, Streamable HTTP, OAuth per client | @modelcontextprotocol/sdk 1.32 | Each assistant gets its own identity, scopes, expiry |
| Jobs | Convex scheduler, called inside the mutation that changes state | – | A scheduled job commits with its state change, which is the outbox guarantee |
| Assistant | Vercel AI SDK with Anthropic provider; default Claude Sonnet 5.5, Opus 5.5 for hard planning | ai 7.0 | Provider-swappable for evals; tools call the same services as REST |
| Telegram | grammY, webhook mode | grammy 1.46 | Maintained, typed |
| WhatsApp | Meta WhatsApp Cloud API via plain HTTP adapter | – | Official API only |
| Contracts | Solidity, Foundry, OpenZeppelin (P256/WebAuthn utils) | @openzeppelin/contracts 5.6 | Fuzz and invariant tests; verified P-256 precompile on Base Sepolia |
| Chain client | viem | 2.57 | Typed calls, receipts, event decoding |
| Chain | Base Sepolia (84532) | – | 0x100 P-256 precompile checked against Wycheproof vectors on 14 Oct |
| Files | S3-compatible private storage (MinIO locally) | – | Statements, receipts, evidence |
| Tests | Vitest, Playwright (virtual WebAuthn authenticator), forge test, eval runner | – | Product, approval flow, contract and attack suites |
| Logs | pino with redaction + `audit_events` table | – | No secrets or card data in logs |

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

Still to add: `apps/executor` (agent keys only), `apps/watcher`, `evals/`.

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
