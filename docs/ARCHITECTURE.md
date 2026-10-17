# How it works

## Parts

| Part | Runs on | Job |
|---|---|---|
| `apps/web` | Vercel (Next.js) | Dashboard, onboarding, agents, wallet, assistant chat, demo sandboxes |
| `apps/approve` | Vercel, separate domain (Vite) | The only place a passkey is created or signs; renders the exact action from its bytes |
| `packages/backend` | Convex | Ledger and imports, the MCP gateway (`/mcp`), task lifecycle, relayer queue, chain reads and writes |
| `packages/domain` | Shared TypeScript | Money, statement parsing, vault encoding, the signed digest, WebAuthn helpers, ABIs |
| `contracts` | Base Sepolia | `PolicyVault` (one per person), `VaultFactory`, `TestUSD` |

Live: dashboard https://nudge-wallet.vercel.app, approval site https://agent-wallet-approve.vercel.app, Convex `ceaseless-raven-960`.

## The vault

One contract per person, holding one token. No admin, no upgrade path.

**Agent payment** (`agentPay(contactId, amount, paymentId, purposeHash)`), checked in this order; any failure emits `PaymentRefused` with a code and returns false, so the refusal is on-chain evidence:

1. caller is a registered agent (else revert), not frozen, vault not frozen
2. agent not expired (2001)
3. contact saved (2010) and past its waiting period (2002)
4. payment id unused (2007)
5. amount within the agent's per-payment limit (2003)
6. agent's rolling 24-hour total within its cap (2003), ring of 16 slots (2009 when full)
7. all agents' rolling 24-hour total within the vault ceiling (2004), ring of 48 slots
8. balance minus held payments minus amount stays at or above the protected amount (2005)

A refusal adds a strike; five within 24 hours freeze that agent. If the amount is above `holdAbove`, the payment is recorded and held for `holdFor` seconds: anyone may `release` it after that unless it was cancelled, the vault or agent was frozen, or the contact changed. Otherwise it is paid at once.

**Rolling window.** Each payment is stored as (time, amount) in a fixed ring. The 24-hour total is the sum of slots newer than now minus 24 hours, so there is no calendar-day reset to double-spend across.

**Owner action** (`execute(action, keyId, auth)`). The passkey signs

```text
digest = keccak256(abi.encode(ACTION_TYPEHASH, op, keccak256(data), nonce, deadline, chainId, vault))
```

The contract checks the deadline, the nonce, that the key is an active owner key, that the authenticator data's site hash is the one stored for that key, and the WebAuthn signature with user verification required (OpenZeppelin `WebAuthn.verify`, P-256 precompile). If the action loosens anything and `changeDelay` is set, it is stored under `changeIdOf(op, data, nonce)` and applies only through `finalize` after the delay; the guardian or the owner can cancel it before then. Tightening applies at once.

Loosening means: a new or larger agent grant, an instant contact, a lower protected amount, a higher ceiling, shorter delays or holds, unfreezing, adding or removing a passkey, or withdrawing.

**Guardian** (our relayer): `freeze`, `freezeAgent`, `cancelHeld`, `cancelChange`. Nothing that moves money or loosens.

## A payment from an outside assistant

1. Claude calls `propose_payment(contactId, amount, reason, requestId?)` on `/mcp` with its bearer key.
2. The gateway refuses or asks for approval in code: scope, frozen, per-payment and daily limits (the stricter of our record and the vault's), shared ceiling, protected amount, new contact. A repeated `requestId` returns the first task.
3. Inside limits: a task is created with a payment id derived from the `requestId` (or the task), and queued on the relayer workpool. The action tops up the agent key's gas if needed, opens the sealed key, simulates on a node that sees the vault, and sends `agentPay` with the agent's own key.
4. The receipt decides: paid, held (release scheduled), or refused with a code. A lost receipt marks the task "unknown" and is reconciled by hash every 30 seconds; nothing retries a payment blindly.
5. Over limits: the task becomes an owner approval with a link to the approval site.

## An owner approval

1. The approval site loads the task, decodes the action bytes into lines, and computes the digest itself.
2. The owner's passkey signs the digest (any of their registered passkeys).
3. The relayer submits `execute`; the receipt shows applied or queued. Queued changes are finalised by the relayer after the delay.
4. After every transaction the backend reads the vault back (limits, balance, holds, spend, per-agent state), and the screens show those numbers.

## Passkey enrolment

1. The signed-in owner asks for a setup link (one-time, 15 minutes, with a server challenge).
2. On the approval site the phone creates a passkey for that site's domain with user verification required.
3. The backend checks the registration (challenge, origin, site hash, flags, that the key matches the one inside the authenticator data) and shows the phone a 6-digit code.
4. The owner types that code into the app. Only then is the vault deployed for the key (or, for a backup passkey, an `AddOwnerKey` approval is created for an existing passkey to sign).

## Accounts

Signed-in users authenticate with Clerk. Demo visitors get a private sandbox: the web app signs a one-hour ES256 token for a random id held in an http-only cookie, and Convex accepts it as a custom JWT provider. The judge account is the same kind of token with a fixed id, issued only after `/judge?key=…`.

## Tests

| Suite | Count | Run |
|---|---|---|
| Contract (unit, fuzz, 13 invariants, requirement tests) | 166 | `cd contracts && forge test` |
| Backend (convex-test: gateway matrix, approvals, Telegram, limits, settlement) | 165 | `pnpm --filter @agent-wallet/backend test` |
| Encoding, digest, statements, gateway audit | 63 | `pnpm --filter @agent-wallet/domain exec vitest run` |
| Everything above | | `pnpm test` |
| Local chain, browser-shaped passkeys | 2 | `ANVIL_URL=… TOKEN=… FACTORY=… vitest run vault.int` |
| Base Sepolia through the real backend | 7 | `vitest run onchain.e2e` (see the file header) |
