# Nudge brand

The rules for how Nudge looks, sounds and moves. The source of truth is code, not this page: [`packages/brand`](../packages/brand) holds the tokens, the characters, the logo and the dot illustrations, and both apps import them. The living sheet is at [`/brand`](https://nudge-wallet.vercel.app/brand). Change the package, then this page; never copy a colour or a face into an app.

Inspiration, for anyone extending it: the characters and their cheek come from Cue (by Manus); the inline mascot and calm white space from Meta's Muse; the conversation-first homepage and numbered sections from Poke and Orchid; the casual, confident voice from HeyClicky; the dot-matrix feature art from OpenAI. We borrow the feeling, never the artwork.

## The idea

**Nudge is the friend who taps you on the shoulder before your AI spends something it shouldn't.** Your assistants get an allowance, not your card. Small things just happen; big things wait for a nudge from you.

Two promises carry everything: *it's on your side* (warm, a little cheeky, never preachy) and *it's exact about money* (real numbers, plain words, no hand-waving). If a design or a sentence breaks either, change it.

## Name

- **Nudge** in sentences, always capitalised: "Nudge paid Blue Tokai $3."
- **nudge** in the wordmark only, lowercase.
- **"nudge!"** in the speech pill, for big moments (hero, social card, end of a tour).
- The money it holds is "your Nudge wallet". Never "Agent Wallet", "AgentWallet" or "the agent wallet" (old names). Internal package names (`@agent-wallet/*`) and identifiers stay as they are.

## The cast

Your own assistant **is** Nudge, and it watches over the others. Every assistant you connect gets its own flat shape and colour with the same big eyes, so a list of agents reads at a glance.

| Character | Shape | Colour | Personality |
|---|---|---|---|
| **Nudge** (your own) | Speech bubble | Nudge Blue `#00BAF2` | The lookout. Warm, quick, a little cheeky, never careless with money. |
| Claude | Soft 8-point burst | Coral `#E97B52` | Thoughtful and thorough; checks before it pays. |
| ChatGPT | Circle | Mint `#2FB27D` | Easygoing all-rounder. |
| Hermes | Rounded triangle | Sunny `#FFC21F` | Fast messenger; always on the move. |
| OpenClaw | Square with two claws | Cherry `#F2545B` | Grabby; the one most likely to try a forwarded invoice. |
| Poke | Squircle | Grape `#8E7CF8` | Lives in your texts. |
| Anyone else | Hexagon | Pebble `#98A2B3` | Anyone new, until it earns a colour. |

**Anatomy.** Flat colour, no outlines, no gradients, no shading. Corners softened like cut paper. Eyes: white ovals with dark pupils that can glance (`look={[x, y]}`). Mouths and brows: thick, round-capped strokes in Ink. Same eyes on every body; the body is identity, the face is mood.

**Adding a character.** Add it to `CAST` in `packages/brand/src/characters.tsx` with the next unused shape (or a new simple one in `Body`) and a colour from `CAST_COLOR`; never a new colour. Give it a one-line personality. Check it at 24px (does the face still read?) and at 160px (do the corners look intentional?). Then add a row here and run `pnpm --filter @agent-wallet/brand assets`.

## Moods

The face says what's happening before any words do, and it must never contradict the words. One mapping, `moodFor(state)`, used everywhere.

| Mood | Face | Use for |
|---|---|---|
| `happy` | Eyes and a smile | Paid, done, active |
| `wink` | One eye, one happy "^" | Your turn: approve with your passkey. Also the logo. |
| `watch` | Eyes glancing up, flat mouth | Held, queued, waiting on the chain |
| `grumpy` | Brows down | Refused: over a limit, unknown contact, stolen key |
| `sleep` | Eyes closed, small "z" | Frozen, cancelled, expired |
| `wow` | Wide eyes, round mouth | Something new: first payment, a new connection |
| `neutral` | Eyes only | Listening; no news |

Faces are for agents and Nudge. People (contacts, guardians) get initials, never a character.

## Logo

Nudge winking, then **nudge** in Mona Sans 900, lowercase, tracking -0.05em. The wink is the signature: keep it on the logo, the app icon and the favicon.

- `Logo` component in code; `packages/brand/assets/logo.svg`, `logo-inverse.svg`, `mark.svg`, `icon.svg` for files.
- Minimum mark size 16px. Clear space: half the mark's width on every side.
- On Ink, use the inverse wordmark (white). On Nudge Blue, use the mark alone.
- Don't recolour the mark, rotate it, add effects, or put it on a busy photo.

## Colour

| Token | Hex | Use |
|---|---|---|
| Nudge Blue | `#00BAF2` | Nudge's body, links, focus, one bright thing per screen |
| Nudge Ink | `#0085C7` | Blue text on white |
| Ink | `#1D1D1F` | Headlines, wordmark, faces, primary buttons |
| Ink 2 | `#505050` | Body text |
| Paper | `#F4F4F1` | Marketing background |
| Deep | `#002970` | Money figures and dense app UI (kept from the original product) |
| Cast | Coral, Mint, Sunny, Cherry, Grape, Pebble | Characters only, never UI chrome |
| States | Good `#0F9D58`, Warn `#C77700`, Bad `#EB5757` | Status text and chips |

Screens are calm: Paper or white, Ink type, and the colour comes from the characters.

## Type

- **Mona Sans** everywhere. Headlines are heavy (800–900) and slightly wide (`font-stretch` 108–112%), tracking -0.04 to -0.05em.
- **Instrument Serif italic** for one accent phrase per headline: "Let your AI pay. *Only within your rules.*" Never body text, never two accents in one headline.
- Numbers use tabular figures (`.num`) wherever amounts line up.

## Voice

Short, warm, a little cheeky; exact about money. Nudge talks like a friend texting you, and never jokes about a refusal you need to act on.

| Do | Don't |
|---|---|
| "done ✓ that's $3 of Claude's $10 today" | "Transaction successfully processed." |
| "that's over Claude's limit. your call:" | "Approval required due to policy constraints." |
| "nope. not a saved contact, so the vault refused it (2010)" | "Oops! Something went wrong 😅" |
| "Test dollars, no real value." | Implying real money anywhere |

- Use real numbers and names. Say what happened, then what you can do.
- Chat lines may be lowercase; product UI and headlines use sentence case.
- No exclamation marks in errors. One emoji at most, and never in anything about a refusal or security.

## Motion

- Every character blinks on its own about every 5.5s (`.nudge-eyes`); it's alive, not busy.
- `bob` (a slow 3.2s float) only for the hero, loading and the one character asking for your attention.
- UI transitions use `cubic-bezier(0.22, 1, 0.36, 1)`.
- All of it stops under `prefers-reduced-motion`. Motion CSS lives in `packages/brand/src/brand.css`; each app imports it once.

## Dots

Dot-matrix illustrations (`<Dots art="shield" />`) explain features: a grid of small dots where some are lit to draw a shield, coin, lock, path, pause or plug. Tint them with the character's colour that goes with the feature. They sit behind copy and never compete with a face. Add a new drawing to `ART` in `packages/brand/src/dots.tsx` as a function from a point in a unit square to brightness.

## Where things live

| What | Where |
|---|---|
| Tokens (colour, type, motion) | `packages/brand/src/tokens.ts` |
| Characters, cast, moods | `packages/brand/src/characters.tsx` |
| Logo and speech pill | `packages/brand/src/logo.tsx` |
| Dot illustrations | `packages/brand/src/dots.tsx` |
| Motion CSS | `packages/brand/src/brand.css` |
| Exported SVGs and app icons | `packages/brand/assets/`, generated by `pnpm --filter @agent-wallet/brand assets` |
| Living sheet | `apps/web/app/brand/page.tsx` → `/brand` |
| Homepage | `apps/web/components/landing.tsx` |
