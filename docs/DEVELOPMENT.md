# Development

## Run locally

```bash
pnpm install
pnpm --dir packages/backend dev     # Convex dev deployment
pnpm --dir apps/web dev             # http://localhost:3000
pnpm --dir apps/approve dev         # http://localhost:3001
```

Env files (not committed): `apps/web/.env.local` needs `NEXT_PUBLIC_CONVEX_URL`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_APPROVE_URL`. `apps/approve/.env.local` needs `VITE_CONVEX_URL`, `VITE_WEB_URL`. The Convex deployment needs `CLERK_JWT_ISSUER_DOMAIN`.

Demo visitors get private sandboxes (needs `DEMO_JWT_PRIVATE_KEY` in the web app and the matching `DEMO_JWKS` on Convex). The judge account (the phone-passkey vault) opens at `/judge` by typing `JUDGE_KEY` (read-only) or `JUDGE_ADMIN_KEY` (the team's, can change it) into the form; only a hash goes in the cookie. Rotate `JUDGE_KEY` after judging. Web env `VISITOR_SALT` salts the per-visitor id used for demo budgets. Convex env `RELAYER_LANES` (1-4) turns on extra relayer keys once funded, and `OPS_TELEGRAM_CHAT_ID` receives low-runway alerts (`npx convex run ops:status` shows the runway). Other Convex env: `AGENT_KEY_SECRET` (32 bytes, base64) seals agent keys.

## Deploy the contracts

Deploy your own: put `RELAYER_PRIVATE_KEY` and `RELAYER_ADDRESS` in `contracts/.env`, fund the address with Base Sepolia ETH (0.0001 covers the contracts and a few vaults), then run `contracts/deploy.sh`. It deploys both contracts and points the Convex deployments at them.

Tests:

```bash
cd contracts && forge test                         # 166 tests: unit, fuzz, invariants, requirements
pnpm --filter @agent-wallet/domain exec vitest run # encoding, digest, statements (tests in packages/domain/test)
E2E_CONVEX_URL=https://<dev>.convex.cloud pnpm --filter @agent-wallet/domain exec vitest run onchain.e2e
```

The last one makes its own demo sandbox on that deployment and spends about 0.00004 ETH of relayer gas; see the file header for the environment it needs. Security self-assessment: [docs/SECURITY.md](docs/SECURITY.md). Architecture and algorithms: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Turn on Telegram

Create a bot with @BotFather, then:

```bash
npx convex env set --prod TELEGRAM_BOT_TOKEN <token>
npx convex env set --prod TELEGRAM_WEBHOOK_SECRET <random string>
npx convex env set --prod TELEGRAM_BOT_USERNAME <bot username without @>
npx convex run --prod telegram:setWebhook
```

## Stack

This is the stack decision record that every contributor (human or agent) follows: change a row here instead of writing a second architecture.

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
| Assistant model | Anthropic SDK, Claude Opus 5.5, server-side refusal fallback | @anthropic-ai/sdk 0.131 | Same tools as MCP; never decides what is allowed |
| Tests | forge test, Vitest (unit, local-chain, Base Sepolia end to end), attack and injection evals in `evals/` | – | Contract, encoding, full-path and adversarial suites |

Planned, not in the code: OAuth for MCP clients, WhatsApp, object storage for files, structured log redaction and an audit table, Playwright journeys.

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

## Open decisions

- Product name (kept in `apps/web/lib/config.ts`).
- Clerk app is a temporary development instance; claim it into a Clerk account before real users.
- Demo token: our mintable tUSD now; Circle test USDC later as well.
- Hosting accounts (Vercel, Neon, container host) versus local Docker first.
- Whether organisers accept testnet hashes.
