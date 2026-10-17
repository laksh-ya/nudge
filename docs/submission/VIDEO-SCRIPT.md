# Demo video script (5 minutes)

For Lakshya to record. Screen capture of the live app (https://nudge-wallet.vercel.app) on a laptop, plus the phone for the passkey. Use a fresh demo sandbox or a team account, never the judge account. Every transaction shown should open on the Base Sepolia explorer. Times are targets; the voiceover is a guide, say it in your own words.

**Before recording:** vault deployed and set up (holds above $5, Claude $10 a payment / $15 a day); Telegram linked; Claude Code connected over MCP with its key; one saved contact (Blue Tokai) and one statement ready to import; the stolen-key script ready in a terminal (`onchain.e2e` stolen-key step, or the README's refusal transaction open in a tab as a fallback).

| Time | Screen | Voiceover |
|---|---|---|
| 0:00–0:20 | Title card, then the dashboard | "AI assistants can now pay for us. The question is what happens when one is fooled, or its key is stolen. Nudge lets any assistant pay, inside rules a contract enforces itself, so the worst case is a number you chose." |
| 0:20–0:45 | Sign in; Home shows accounts, bills, safe-to-spend | "It starts as a personal finance app: accounts, bills, what's safe to spend." |
| 0:45–1:05 | Import a statement; spending updates | "Import a statement and the numbers update. Assistants read these numbers through tools, never by guessing." |
| 1:05–1:40 | Terminal: Claude Code. Type "Pay Blue Tokai $3 for coffee." Claude calls `propose_payment`; then the activity shows paid; click the transaction | "Here's Claude, an outside assistant, connected over MCP with its own key and its own limits. Three dollars is inside them, so it pays at once. This is the transaction on Base Sepolia, signed by Claude's own key." |
| 1:40–2:10 | Ask Claude to pay $8. Activity: held, 2-minute countdown. Tap Cancel. Explorer: PaymentHeld then PaymentCancelled | "Eight dollars is above the five-dollar hold. The vault holds it for two minutes, and I can cancel. Cancelled: the money never left." |
| 2:10–2:50 | Ask for $12. Phone: Telegram card arrives; open in browser; approval page shows "Pay Blue Tokai $12" rebuilt from the signed bytes; Face ID; confirmed | "Twelve is over Claude's ten-dollar limit, so it comes to me. Claude never gets a link. On my phone the approval page shows exactly what I'm signing, built from the bytes, and my passkey signs it. The contract checks that signature itself." |
| 2:50–3:25 | Terminal: stolen key sends $50 straight to the contract. Explorer: PaymentRefused, code 2003. Then a payment to an unknown address: 2010 | "Now assume Claude's key is stolen and our server is bypassed. Fifty dollars: refused by the contract, code 2003, recorded on-chain. A new address: refused, 2010. Five refusals and the key freezes itself." |
| 3:25–3:50 | Chat or Telegram: "freeze". Activity: frozen in the vault. Claude tries again: refused | "If something looks wrong, one word in chat freezes every assistant, in the vault, at once. Unfreezing needs my passkey and a wait." |
| 3:50–4:35 | Slide: injection results table; then `evals/P0.md` scrolling | "We attacked it with 38 prompt injections, twelve hidden in my own bills and contacts. Claude Opus, Sonnet and Haiku refused all of them. With a model scripted to obey every attack, it still sent nothing to an address that isn't a saved contact. Sixty-three of our 68 priority attacks are automated tests, and every transaction we cite is checked against the chain by a script." |
| 4:35–5:00 | Proof page: vault record and "if every key leaked: at most $X today" | "This page reads the vault from the chain, not from us: everything it did, and the most a stolen key could take today. Testnet, test money, real contract. Thank you." |

**Captions to show on screen:** transaction hashes as they appear; "Base Sepolia testnet, test token tUSD, no real money".

**If something breaks while recording:** cut to the README evidence table and the explorer tab for that step; say "recorded earlier" on screen.
