# agent-wallet (working name) 

A testnet wallet that lets AI agents pay saved contacts within owner-set limits. The vault contract enforces those limits even if an agent's key is stolen. Anything larger, and any change that loosens a rule, needs the owner's passkey signature over the exact action, and loosening then waits out a delay the owner can cancel. Around it sits a personal-finance app (dashboard, imports, bills) with its own assistant. Bank feeds, family transfers and some demo history are simulated.

Entry for FinTechathon 2026, Topic F (Agent Wallet). Product spec: `reports/Full product plan.md` in the research workspace. This file is the stack decision record that Claude and Codex both follow; change a row here instead of writing a second architecture.

## For judges

You don't need our phone. Everything below runs on Base Sepolia test money, in your own private sandbox.

1. Open the web app and choose **Try the demo**. You get a sandbox only your browser can open, with sample accounts, bills and connected assistants.
2. Go to **Wallet → Put this wallet on-chain**. Create the passkey on your phone (scan the QR) or on this laptop (Touch ID, Windows Hello, or a security key), then type the six-digit code the passkey screen shows. Your own vault is deployed in about a minute.
3. Approve the setup with that passkey. From then on the vault enforces the limits: ask the assistant to pay Blue Tokai a few dollars (it goes through), then more than Claude's limit (it waits for your passkey), and open the approval link to see exactly what you'd sign.
4. Try to break it: freeze Claude, change limits, or connect your own assistant over MCP (section below).

Each visitor can make 3 demo vaults a day. If the demo's test ETH runs low, new vaults wait until it's topped up; nothing you already have stops working.

The team's own account (with the phone-passkey vault and recorded history) opens read-only at `/judge` with the judge key, typed into the form there. The key is never part of a link. From it, **Open your own sandbox** switches to a fresh sandbox.

## What is live and what is simulated

| Area | State |
|---|---|
| Vault payments (agent within limits, held, owner-approved, refused) | Live on Base Sepolia, test token tUSD (no value) |
| Passkey approval and enrolment | Live: browser WebAuthn on the approval site, verified by the contract |
| Freeze, unfreeze, disconnect, limit changes | Live: every route acts on the vault and is confirmed by reading it back |
| Claude and other assistants over MCP | Live: JSON-RPC over HTTP with per-assistant bearer keys (OAuth not yet) |
| Built-in assistant | Claude (`claude-opus-5-5`) with the same tools outside assistants get over MCP, so the gateway and vault decide every payment; rule-based replies when `ANTHROPIC_API_KEY` isn't set on the deployment |
| Bank feeds | Sandbox data per country; statement import (CSV, Excel, PDF, receipts) is real |
| Family transfers and quotes | Simulated |
| UPI | Hands the payment to your UPI app; no bank settlement confirmation |
| Telegram | Live as [@Agent_eallet_bot](https://t.me/Agent_eallet_bot): link from Settings → Telegram (one-use 10-minute code), re-linking needs the owner's yes, each update handled once; approvals arrive as a link that opens in the phone's browser |
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
| VaultFactory (v3, current) | [`0xF0D906bdec522087992EA711710Ee60F2a8DA95e`](https://sepolia.basescan.org/address/0xF0D906bdec522087992EA711710Ee60F2a8DA95e) (deployed in [`0x8c091288…`](https://sepolia.basescan.org/tx/0x8c0912888e939bed5c9dc992248c2c4af2414a6c671c50685a10a774d7b5bb41)) |
| VaultFactory (v2, retired) | [`0x672DcD9A822030371d017673403edc290c9d8975`](https://sepolia.basescan.org/address/0x672DcD9A822030371d017673403edc290c9d8975) |
| VaultFactory (v1, retired) | [`0x223c60BAa1C2EfCD0F95B0D73e51D6De9460Baa9`](https://sepolia.basescan.org/address/0x223c60BAa1C2EfCD0F95B0D73e51D6De9460Baa9) |
| TestUSD (tUSD, 6 decimals) | [`0xB0ee01235A8e7903519B029c1530332f5847D932`](https://sepolia.basescan.org/address/0xB0ee01235A8e7903519B029c1530332f5847D932) |
| Example v1 vault | [`0xC6299CFc10366cBD576AFFc13a6f0440413d3510`](https://sepolia.basescan.org/address/0xC6299CFc10366cBD576AFFc13a6f0440413d3510) |
| Example v2 vault | [`0xa395739975FD3f66b83CbCf6ad535029e5a94e73`](https://sepolia.basescan.org/address/0xa395739975fd3f66b83cbcf6ad535029e5a94e73) |
| Example v3 vault | [`0x0a130A0cCABA11faA1c653f5ea4D76Adb36194d3`](https://sepolia.basescan.org/address/0x0a130a0ccaba11faa1c653f5ea4d76adb36194d3) |

Contract v3 (16 Oct, after review #32), one full run of `packages/domain/src/onchain.e2e.test.ts` (7 of 7 passed) and `resilience.e2e.test.ts` (3 of 3) through the real backend on the dev deployment, vault [`0x0a130a0c…`](https://sepolia.basescan.org/address/0x0a130a0ccaba11faa1c653f5ea4d76adb36194d3) reporting `VERSION() == 3`.

| Step | Who signs | Transaction |
|---|---|---|
| Vault deployed from the v3 factory after the owner typed the code | relayer | [`0x16ffc2cf…`](https://sepolia.basescan.org/tx/0x16ffc2cf41bfbe9ec897f558b090ddaf1334bfb032b743f22b5bd644f5dcfefd) |
| Setup: agents, contacts and rules | passkey | [`0x251636f7…`](https://sepolia.basescan.org/tx/0x251636f7e8c22660fcbe8a0fba009bec6fca95ebc2cd880e31b6c3fb50393943) |
| Claude pays $3 at once | Claude's agent key | [`0x7d93f727…`](https://sepolia.basescan.org/tx/0x7d93f727d650323704373f61799ec3fda49dde095a64c10a6d84896b0594789c) |
| Claude pays $6: above $5, so the vault holds it | Claude's agent key | [`0xa119acfa…`](https://sepolia.basescan.org/tx/0xa119acfa4b25b047cd8e086a223cfa07bbf0cde8d547bbcdb66f0fe107a1560f) |
| Held $6 released after the 2-minute window | relayer (`release`) | [`0x9a7b0017…`](https://sepolia.basescan.org/tx/0x9a7b0017f9ef6faa9cdade24a16f23ecec90f049266e74a585fcd1ca7155c76b) |
| Owner approves $12, keeping the protected amount | passkey | [`0x89948646…`](https://sepolia.basescan.org/tx/0x89948646fe987b6489ab3f60d95abe6f36ed4db1d1a39ae59d5b37f4a1dfa8a5) |
| Stolen key: $50 → refused 2003 | agent key, bypassing our server | [`0x0563fdac…`](https://sepolia.basescan.org/tx/0x0563fdacf54f69d18a35f7d5a0a4668bd881781b2635c565df17ecf8eb9c80bd) |
| Stolen key: replay → refused 2007 | agent key, bypassing our server | [`0xf9be31b8…`](https://sepolia.basescan.org/tx/0xf9be31b8f157b21155478e7c23e3dc50b7741e2749225fdbccc485f716b38af4) |
| Stolen key: unknown contact → refused 2010 | agent key, bypassing our server | [`0x5176f1df…`](https://sepolia.basescan.org/tx/0x5176f1df4ef48679cfc88a55cddf9631f036710ddd29445cfdc27cf7cc4ccce1) |
| Stolen key: refused again (4 strikes) | agent key, bypassing our server | [`0x07e36acc…`](https://sepolia.basescan.org/tx/0x07e36accf3146b1bd2f4db81987ac97a0fb2ca3f82b220030d235d12fff75fc8) |
| Stolen key: 5th refusal freezes it | agent key, bypassing our server | [`0x9e852068…`](https://sepolia.basescan.org/tx/0x9e852068f278fa9810a1cc9367979aa106238609e8bb3fca863c8d8dea369781) |
| Owner signs an unfreeze: queued, not applied | passkey | [`0xffc6955e…`](https://sepolia.basescan.org/tx/0xffc6955e6ebd71716c3d6acb5872cb31faf76b3e8cb707e9ff7d238ed2605633) |
| Unfreeze applied after the 2-minute delay | relayer (`finalize`) | [`0xc1326865…`](https://sepolia.basescan.org/tx/0xc1326865fcf8704b051f7459af23c491a72493abdd6f179f01c8fe4a8ca80863) |
| Disconnected agent's key removed from the vault | passkey | [`0x5463f383…`](https://sepolia.basescan.org/tx/0x5463f38384c174b2b794e6a5f3b3a416090cbfcde08c46fefab23dfa59f10a82) |

Races and lost receipts on v3, vault [`0xc651daa8…`](https://sepolia.basescan.org/address/0xc651daa8d459935cdad40fd1e5ea51f43d81efac): four simultaneous $6 requests against a $15 daily cap pay two; a payment whose receipt is lost stays unknown, a retry is refused as a duplicate, and it settles once from the chain.

| Step | Who signs | Transaction |
|---|---|---|
| Vault deployed | relayer | [`0x49bccccf…`](https://sepolia.basescan.org/tx/0x49bccccf437e8f5f7a3016f278043a7683e073435894b76e4eb9c3d6e46c201f) |
| Setup approved | passkey | [`0x887c0209…`](https://sepolia.basescan.org/tx/0x887c020976e0e64fd478110ccee9d71e16726ba8505161fb259301a7632dce97) |
| Race: $6 held for the owner's 2 minutes (8gc5tv) | Claude's agent key | [`0x40a37f37…`](https://sepolia.basescan.org/tx/0x40a37f3771d1782c62a97dca8bc116bbddacee5a6fefc3d3aa4a5d0a5e034738) |
| Race: $6 held for the owner's 2 minutes (8gcx4s) | Claude's agent key | [`0x2467239e…`](https://sepolia.basescan.org/tx/0x2467239ea0d599861962c2b331b3f129898837bbd6fe9d65a33c17d8cefae0d1) |
| Race: $6 released after the hold (8gc5tv) | relayer | [`0x837b5ef7…`](https://sepolia.basescan.org/tx/0x837b5ef71b841f1d6d56c4c797c30e603010096275957b4714d3e523c68638e3) |
| Race: $6 released after the hold (8gcx4s) | relayer | [`0xa9455342…`](https://sepolia.basescan.org/tx/0xa94553426b8836fc9c95009a2190457753a788dbd25a4062a7f61f5beccc2b98) |
| Lost receipt reconciled: paid once | Claude's agent key | [`0xa2fcd439…`](https://sepolia.basescan.org/tx/0xa2fcd43972b3b1f0ad5611729127df3117e9e11b5bf9594e5995ab5d422fa9ee) |

Contract v2, one full run of `packages/domain/src/onchain.e2e.test.ts` (7 of 7 passed) through the real backend, with a software P-256 key shaped like a browser's. Also covered without a transaction: a registration answering another challenge, a reused setup link and a wrong confirmation code are refused; a retried `requestId` returns the first payment; a held payment is cancelled; after a chat "freeze" the old key reverts with `AgentFrozen`.

| Step | Who signs | Transaction |
|---|---|---|
| Vault deployed after the owner typed the phone's code | relayer | [`0x3e3c79c8…`](https://sepolia.basescan.org/tx/0x3e3c79c8dccd4bfb27d16070d19ec2ef2ad5888fb30539f8a8d6ecdd251e975c) |
| Setup: agents, contacts and rules (2-min loosening delay, holds above $5) | passkey | [`0x80c2b3f8…`](https://sepolia.basescan.org/tx/0x80c2b3f851f0bd97c6351e71c001c999cd668daabb931767a87305e27f318765) |
| Claude pays $3 over MCP, at once | Claude's agent key | [`0x6e4806e4…`](https://sepolia.basescan.org/tx/0x6e4806e4564247d56b62c66ba8f66058d68283ab5a8d6340583a43a1caca08ca) |
| Claude pays $6: above $5, so the vault holds it | Claude's agent key | [`0xb545a44f…`](https://sepolia.basescan.org/tx/0xb545a44fbd1961ecbec312c7d53e03bc35d321a7a0130d625d11a5c8a622d6ea) |
| Held $6 released after the 2-minute window | relayer (`release`) | [`0x3c683069…`](https://sepolia.basescan.org/tx/0x3c683069bf8fd44283e165b2663e0e819ec6c87563ca4f8262fae92a751faceb) |
| Owner approves $12, keeping the protected amount | passkey | [`0x85e01b58…`](https://sepolia.basescan.org/tx/0x85e01b5803549bc26f304aa5617393360b512ee3501555d3e2f4faed2e871676) |
| Stolen key tries $50: refused, code 2003 | agent key, bypassing our server | [`0x3981ea8e…`](https://sepolia.basescan.org/tx/0x3981ea8efdec559f3b322b737353f82a52ff908df87621f7964263ec05bfc176) |
| Stolen key reuses a paid payment id: refused, code 2007 | agent key | [`0x8022158e…`](https://sepolia.basescan.org/tx/0x8022158ee900c5df2a8174162724283dc71e416555f9a2faeb95b5d7ca5a3811) |
| Stolen key pays an unknown contact: refused, code 2010 | agent key | [`0xaf60bc92…`](https://sepolia.basescan.org/tx/0xaf60bc92578e76687ae5ab26ea1924e4e0a6c8221c69f0be036113f130e3fea1) |
| Fourth refusal | agent key | [`0xf07a86b4…`](https://sepolia.basescan.org/tx/0xf07a86b4f0113f748cdd2c4794f1d692d7d3d79a43d5d5df384d1c1f9ec4e57e) |
| Fifth refusal: the vault freezes that key itself | agent key | [`0x8558f8a6…`](https://sepolia.basescan.org/tx/0x8558f8a6b677bdbc6ecfde942e8b78a7804eca39b595f1373b5ca85f9286d0ae) |
| Owner signs an unfreeze: queued, not applied | passkey | [`0xfbd828ef…`](https://sepolia.basescan.org/tx/0xfbd828ef01f27fbad3c8acbf6c04bbb54d917c0efc6169599c6717d13f70f803) |
| Unfreeze applied after the 2-minute delay | relayer (`finalize`) | [`0x8ddbdbd8…`](https://sepolia.basescan.org/tx/0x8ddbdbd817fe4fb900c4e1e67820a85f2a97846b8bd8d8f4c9153fccfc02807c) |
| Disconnected agent's key removed from the vault | passkey | [`0x569ff396…`](https://sepolia.basescan.org/tx/0x569ff39695b5c1a1fe62275302f584f2a67f1c7a286520d82d95657266d31979) |

Contract v2 on the live app with a passkey on a real phone (Android, Chrome), vault [`0x5169E18E…`](https://sepolia.basescan.org/address/0x5169E18E11682316978BDdc430a781f62d586284). The passkey counted only after the code the phone showed was typed into the app.

| Step | Who signs | Transaction |
|---|---|---|
| Vault deployed for the confirmed phone passkey | relayer | [`0x79a892af…`](https://sepolia.basescan.org/tx/0x79a892af8886faaec747e795faf204894f797aefe219ca608406009afd47851f) |
| Setup: agents, contacts and rules | phone passkey | [`0x00c3e632…`](https://sepolia.basescan.org/tx/0x00c3e632d88f6c83d038c9c44aff118d80cb07f8aa089d23b1e76b2b413d9eac) |
| Claude pays $3 over MCP, at once | Claude's agent key | [`0x6977e395…`](https://sepolia.basescan.org/tx/0x6977e3957d2d1ba4562410b6235ff71f3fd2a6c0e0fb3ecc517b28660683886b) |
| Claude pays $8: above $5, so the vault holds it | Claude's agent key | [`0xddf143e6…`](https://sepolia.basescan.org/tx/0xddf143e6270ef3dfca7a89a0416873c4cc1bb3901b687bcea058248b133a5d5f) |
| Held $8 released after 2 minutes | relayer (`release`) | [`0x14e713bf…`](https://sepolia.basescan.org/tx/0x14e713bf678a85b00eca778e047d907d45127c0702e4245ae7826162a5eb5fb2) |
| Claude asks for $12, over its $10 limit; owner approves on the phone | phone passkey | [`0xb671f42d…`](https://sepolia.basescan.org/tx/0xb671f42d4bffae21aeff37ce9edf82740b7cb5543467ccffa74ed4b9acc6fce1) |

The judge account (opened with `/judge?key=…`) moved from its v1 vault [`0xd71b81a1…`](https://sepolia.basescan.org/address/0xd71b81a157Ce1D4651D2B1CF0CCb59bea789Ae40) to v2 vault [`0xC9746222…`](https://sepolia.basescan.org/address/0xC9746222bdf0959B8ce3cE0F21C26c7c217f1EB1) with the same phone passkey; the old vault stays on-chain as history.

| Step | Who signs | Transaction |
|---|---|---|
| v2 vault deployed for the existing phone passkey | relayer | [`0x156869e9…`](https://sepolia.basescan.org/tx/0x156869e9977d19e8d6f3b6dcbe7af21b6047c32b6107151547e360f677cb5c6e) |
| Setup: agents, contacts and rules | phone passkey | [`0xa8ba0f39…`](https://sepolia.basescan.org/tx/0xa8ba0f394c0244ff3ae90234b21eab6ecf43413ba31a7c429bc90ff0cda84f9b) |
| Claude pays $3 over MCP, at once | Claude's agent key | [`0x615d6621…`](https://sepolia.basescan.org/tx/0x615d6621f0e186cb9870e533b6df0a8a26395d5c2f62b256d09e72bb5aa8a539) |
| Claude pays $8: held for 2 minutes | Claude's agent key | [`0xbedd4d5f…`](https://sepolia.basescan.org/tx/0xbedd4d5f1d10c155300394e618ee297f63c762bb42ed4a5576932371ff014b50) |
| Held $8 released | relayer (`release`) | [`0x79f7dd41…`](https://sepolia.basescan.org/tx/0x79f7dd41d37521a8402c3e8cb65d6876ba443c91ab394777b9905c909c3900e4) |
| Claude asks for $12, over its $10 limit; owner approves on the phone | phone passkey | [`0xcda7773e…`](https://sepolia.basescan.org/tx/0xcda7773e0408da8e958bddbff7ec595a91587221e02a08120ec6135de99a8be9) |
| Claude asks for $12 again; the approval arrives in Telegram and the owner approves from it | phone passkey | [`0x33c12bbc…`](https://sepolia.basescan.org/tx/0x33c12bbce3cb6ebf32b6972302af3ea697eb2eda10565ed0d3fe2836b8f1aeae) |

Contract v1, one run of the earlier end-to-end test:

| Step | Who signs | Transaction |
|---|---|---|
| Vault deployed for the passkey | relayer | [`0xd2056b73…`](https://sepolia.basescan.org/tx/0xd2056b7302cdbd68a40d40be9b47a72887a9f5177b20a07016d35c1221f3ff3e) |
| Setup: 2 agents and 6 contacts in one approval | passkey | [`0x089acf28…`](https://sepolia.basescan.org/tx/0x089acf28e2a84fa0dfc0497cdffa6cc4c4c10b33a887532575b094eb2091db25) |
| Claude pays Blue Tokai $8 within its limits | Claude's agent key | [`0xde9860d4…`](https://sepolia.basescan.org/tx/0xde9860d4c13782b76ae2532001dd75447025eb131b2e2e25c28c4f3f338a326b) |
| Claude asks for $18, over its limit; owner approves | passkey | [`0xb7272497…`](https://sepolia.basescan.org/tx/0xb7272497d2e05893a692decdfdbafc13cb3f165f2b13536f44ecce98962e60f1) |
| Stolen agent key tries $50: refused, code 2003 | agent key, bypassing our server | [`0xe404d5f3…`](https://sepolia.basescan.org/tx/0xe404d5f31ed429ef92a2bba13e5fc998d787631f96be9024fa3e58b9a1042cb4) |
| Stolen key reuses an earlier payment's id (the owner-approved $18): refused, code 2007 | agent key | [`0xb2c2e268…`](https://sepolia.basescan.org/tx/0xb2c2e2688c9d51e2c806f7db8698de39da993c96eddea5ddab7bbc47b90ec8f5) |
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
cd contracts && forge test                         # 45 tests, fuzz and invariants
pnpm --filter @agent-wallet/domain exec vitest run # encoding, digest, statements
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

## Run locally

```bash
pnpm install
pnpm --dir packages/backend dev     # Convex dev deployment
pnpm --dir apps/web dev             # http://localhost:3000
pnpm --dir apps/approve dev         # http://localhost:3001
```

Env files (not committed): `apps/web/.env.local` needs `NEXT_PUBLIC_CONVEX_URL`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_APPROVE_URL`. `apps/approve/.env.local` needs `VITE_CONVEX_URL`, `VITE_WEB_URL`. The Convex deployment needs `CLERK_JWT_ISSUER_DOMAIN`.

Demo visitors get private sandboxes (needs `DEMO_JWT_PRIVATE_KEY` in the web app and the matching `DEMO_JWKS` on Convex). The judge account (the phone-passkey vault) opens at `/judge` by typing `JUDGE_KEY` (read-only) or `JUDGE_ADMIN_KEY` (the team's, can change it) into the form; only a hash goes in the cookie. Rotate `JUDGE_KEY` after judging. Web env `VISITOR_SALT` salts the per-visitor id used for demo budgets. Convex env `RELAYER_LANES` (1-4) turns on extra relayer keys once funded, and `OPS_TELEGRAM_CHAT_ID` receives low-runway alerts (`npx convex run ops:status` shows the runway). Other Convex env: `AGENT_KEY_SECRET` (32 bytes, base64) seals agent keys.

## Open decisions

- Product name (kept in `apps/web/lib/config.ts`).
- Clerk app is a temporary development instance; claim it into a Clerk account before real users.
- Demo token: our mintable tUSD now; Circle test USDC later as well.
- Hosting accounts (Vercel, Neon, container host) versus local Docker first.
- Whether organisers accept testnet hashes.
