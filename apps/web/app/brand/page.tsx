import type { Metadata } from "next";
import Link from "next/link";
import { CAST, CAST_COLOR, COLOR, Character, Dots, Logo, Shout, type DotArt, type Mood } from "@agent-wallet/brand";

export const metadata: Metadata = { title: "Brand · Nudge", description: "Nudge's logo, characters, colours, type and voice." };

const MOODS: { mood: Mood; when: string }[] = [
  { mood: "happy", when: "Paid, done, all good" },
  { mood: "wink", when: "Your turn: approve with your passkey" },
  { mood: "watch", when: "Held or waiting on the chain" },
  { mood: "grumpy", when: "Refused: over a limit, unknown contact, stolen key" },
  { mood: "sleep", when: "Frozen, cancelled or expired" },
  { mood: "wow", when: "Something new: first payment, a new connection" },
  { mood: "neutral", when: "Listening; no news" },
];

const PALETTE: [string, string, string][] = [
  ["Nudge Blue", COLOR.nudge, "Nudge's body, links, focus"],
  ["Ink", COLOR.ink, "Headlines, wordmark, faces"],
  ["Paper", COLOR.paper, "Marketing background"],
  ["Deep", COLOR.deep, "Money figures, dense UI"],
  ["Coral", CAST_COLOR.coral, "Claude"],
  ["Mint", CAST_COLOR.mint, "ChatGPT"],
  ["Sunny", CAST_COLOR.sunny, "Hermes"],
  ["Cherry", CAST_COLOR.cherry, "OpenClaw"],
  ["Grape", CAST_COLOR.grape, "Poke"],
  ["Pebble", CAST_COLOR.pebble, "Any other assistant"],
];

const DOTS: [DotArt, string][] = [
  ["shield", "The vault checks every rule"],
  ["coin", "Small payments just happen"],
  ["lock", "Your passkey for the big ones"],
  ["path", "A delay you can cancel"],
  ["pause", "Freeze in one tap"],
  ["plug", "Bring any AI over MCP"],
];

function Section({ title, children, note }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-black/10 py-12">
      <h2 className="text-[28px] font-black tracking-[-0.04em] [font-stretch:110%]">{title}</h2>
      {note && <p className="mt-1 max-w-[60ch] text-body text-ink-2">{note}</p>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

/** A living brand sheet, rendered from packages/brand. The written rules are in docs/BRAND.md. */
export default function BrandPage() {
  return (
    <div className="min-h-dvh bg-paper text-coal">
      <div className="mx-auto max-w-5xl px-5 py-10">
        <header className="flex items-center justify-between">
          <Link href="/" aria-label="Nudge home"><Logo size={26} /></Link>
          <span className="text-label text-ink-2">Brand sheet · source: packages/brand · rules: docs/BRAND.md</span>
        </header>

        <div className="flex flex-col items-center gap-8 py-16 text-center">
          <Shout size={72} />
          <div className="flex items-end gap-4">
            <Character of="claude" mood="happy" size={96} look={[3, 0]} />
            <Character of="nudge" mood="wink" size={140} bob />
            <Character of="hermes" mood="watch" size={96} />
          </div>
          <p className="max-w-[46ch] text-title text-ink-2">
            Nudge is the friend who taps you on the shoulder before your AI spends something it shouldn&apos;t. Every assistant gets a face; the face tells you what&apos;s happening.
          </p>
        </div>

        <Section title="Logo" note="Nudge winking, then “nudge” in heavy lowercase. Keep the wink. Minimum 16px; clear space is half the mark.">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid h-40 place-items-center rounded-3xl bg-white"><Logo size={40} /></div>
            <div className="grid h-40 place-items-center rounded-3xl bg-coal"><Logo size={40} inverse /></div>
            <div className="grid h-40 place-items-center rounded-3xl bg-nudge"><Character of="nudge" mood="wink" size={96} /></div>
          </div>
        </Section>

        <Section title="The cast" note="Your own assistant is Nudge. Every assistant you connect gets its own shape and colour, with the same eyes. New ones take the next unused shape and colour; never invent a colour.">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
            {Object.entries(CAST).map(([key, c]) => (
              <div key={key} className="flex flex-col items-center gap-2 rounded-3xl bg-white p-4 text-center">
                <Character of={key} mood={key === "nudge" ? "wink" : "happy"} size={72} />
                <div className="text-body font-bold">{c.name}</div>
                <div className="text-label text-ink-2">{c.personality}</div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Moods" note="One mapping from state to face (moodFor in packages/brand). The face never contradicts the words.">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-separate border-spacing-y-2">
              <tbody>
                {MOODS.map(({ mood, when }) => (
                  <tr key={mood} className="bg-white">
                    <td className="rounded-l-2xl px-4 py-3 text-body font-bold">{mood}</td>
                    <td className="px-4 py-3 text-label text-ink-2">{when}</td>
                    <td className="rounded-r-2xl px-4 py-3">
                      <div className="flex gap-3">
                        {["nudge", "claude", "chatgpt", "hermes", "openclaw"].map((of) => (
                          <Character key={of} of={of} mood={mood} size={40} />
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="Colour">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {PALETTE.map(([name, hex, use]) => (
              <div key={name} className="overflow-hidden rounded-2xl bg-white">
                <div className="h-20" style={{ background: hex }} />
                <div className="p-3">
                  <div className="text-body font-bold">{name}</div>
                  <div className="num text-label text-ink-2">{hex}</div>
                  <div className="text-label text-mute">{use}</div>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Type" note="Mona Sans for everything; heavy and wide for headlines. One accent phrase per headline in Instrument Serif italic.">
          <div className="rounded-3xl bg-white p-8">
            <p className="text-[48px] leading-[1.05] font-black tracking-[-0.045em] [font-stretch:112%]">
              Your AI can pay. <span className="font-serif font-normal italic tracking-[-0.02em]">Only within your rules.</span>
            </p>
            <p className="mt-4 max-w-[60ch] text-title text-ink-2">Body copy is Mona Sans at a normal width: short sentences, real numbers, no jargon.</p>
          </div>
        </Section>

        <Section title="Dots" note="Dot-matrix illustrations explain features: calm and technical, behind the copy, never competing with the characters.">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {DOTS.map(([art, label]) => (
              <div key={art} className="flex flex-col items-center gap-3 rounded-3xl bg-white p-6">
                <Dots art={art} size={160} />
                <div className="text-label font-semibold text-ink-2">{label}</div>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}
