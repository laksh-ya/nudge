# agent-wallet (working name)

A personal-finance app with its own assistant, a dashboard, and a wallet that lets AI agents spend within limits the owner sets. People use it on the web, through Telegram (then WhatsApp), or through an outside assistant over MCP. Every surface shares one account, one ledger, one task list and one payment lifecycle.

Entry for FinTechathon 2026, Topic F (Agent Wallet). Product spec: `reports/Full product plan.md` in the research workspace. Team architecture reference: `PactVault/docs/03-architecture.md` and `06-decisions.md`.

Nothing is built yet. This file is the stack decision record that Claude and Codex both follow; change a row here instead of writing a second architecture.

## Stack

| Layer | Use | Version checked 14 Oct 2026 | Why |
|---|---|---|---|
| Language | TypeScript (strict) everywhere off-chain | – | One set of schemas for web, API, tools, workers |
| Monorepo | pnpm workspaces + Turborepo | turbo 2.11 | Separate deployables, shared packages |
| Shared schemas | Zod | 4.6 | One definition feeds REST, MCP and assistant tools |
| Dashboard | Next.js App Router, Tailwind, shadcn/ui, installable PWA | next 16.4, tailwind 4.3 | Main product UI |
| Approval site | Separate Vite + React static app on its own host and passkey RP ID; no analytics; strict CSP | – | The only place owner signing happens; a hacked backend or dashboard can't alter it |
| API gateway | Hono on Node: REST, MCP server, chat webhooks | hono 4.13 | One path for every money operation, whoever calls it |
| App login | Better Auth (email/OAuth + optional login passkey), Drizzle adapter | better-auth 1.7 | Sessions and app passkeys we control |
| Payment passkey | SimpleWebAuthn on the approval site; P-256 public key stored on the vault | @simplewebauthn 14.0 | Separate from login, so recovering email can't replace the wallet owner |
| Outside agents | Official MCP TypeScript SDK, Streamable HTTP, OAuth per client | @modelcontextprotocol/sdk 1.32 | Each assistant gets its own identity, scopes, expiry |
| Database | PostgreSQL + Drizzle ORM / drizzle-kit | drizzle-orm 0.45 | Row locks and transactions for reservations; integer minor units |
| Jobs | Transactional outbox table + pg-boss | pg-boss 12.38 | Queue lives in the same database as the state it changes |
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
| Clerk, Auth0, Privy, Dynamic, thirdweb, Turnkey embedded wallets | Owner signing key must stay with the owner and be verified by our contract, not held by a vendor |
| Convex, Supabase, Firebase as system of record | Need SQL transactions and row locks for reservations and the outbox |
| Redis/BullMQ, Temporal, Inngest, Vercel Workflow | Payment state and its job must commit in one Postgres transaction |
| LangChain, LangGraph, CrewAI | Agent loop is small; money decisions are plain code, not framework |
| Next.js server actions for money operations | Chat, MCP and dashboard must share one API path |
| Prisma, ethers.js, Hardhat | Drizzle, viem and Foundry instead |
| wagmi/RainbowKit wallet-connect onboarding | Consumers sign with a passkey, not MetaMask (optional second key later) |
| ERC-4337, paymasters, Safe, EIP-7702 in the first version | Vault verifies signatures itself; smaller security core. 4337 is later polish |
| Telegram Mini App or in-app browser for approval | Passkeys fail in Telegram's web view; approvals open in Safari/Chrome |
| Baileys, whatsapp-web.js | Against WhatsApp terms; account bans |
| Upgradeable proxy with an admin key | Admin could silently change spending rules |
| Floats for money, `block.timestamp / 1 days` caps | Rounding errors; double spend at midnight |
| Mainnet, FISCO BCOS as main chain | Testnet prototype; FISCO only as optional anchor |

## Layout

```text
apps/web          dashboard (Next.js)
apps/approve      approval site (static, separate host)
apps/api          gateway: REST, MCP, Telegram/WhatsApp webhooks
apps/worker       outbox, imports, reminders, reconciliation
apps/executor     holds agent keys only; submits vault calls
apps/watcher      reads chain events, alerts owner independently
packages/domain   Zod schemas, money types, task and payment states
packages/db       Drizzle schema and migrations
packages/finance  ledger, dedupe, bills, forecasts, affordability
packages/policy   permission checks and reservations
packages/payments adapters: chain, simulator, provider sandbox
packages/assistant tools, prompts, response checks
packages/channels Telegram and WhatsApp adapters
packages/chain    ABIs, viem clients
packages/evidence receipts, verifier
packages/ui       shared components
contracts/        PolicyVault, VaultFactory, test tokens; Foundry tests
evals/            task and attack scenarios, results
```

## Open decisions

- Product name (kept in one config constant).
- Demo token: our mintable TEST tokens, Circle test USDC, or both.
- Hosting accounts (Vercel, Neon, container host) versus local Docker first.
- Whether organisers accept testnet hashes.
