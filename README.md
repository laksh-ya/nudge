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
apps/web          dashboard (Next.js, Clerk, Convex)
apps/approve      approval site (Vite, separate host)
packages/backend  Convex schema and functions
packages/domain   money formatting, payment states
```

Still to add: `apps/executor` (agent keys only), `apps/watcher`, `contracts/` (Foundry), `evals/`.

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
- Demo token: our mintable TEST tokens, Circle test USDC, or both.
- Hosting accounts (Vercel, Neon, container host) versus local Docker first.
- Whether organisers accept testnet hashes.
