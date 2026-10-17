"use client";

import Link from "next/link";
import { ArrowRight, ArrowUpRight, Fingerprint } from "lucide-react";
import { CAST, Character, Dots, Logo, Shout, type DotArt, type Mood } from "@agent-wallet/brand";
import { useDemo } from "@/lib/demo";

/**
 * The marketing homepage. Brand rules (cast, moods, type, voice) live in docs/BRAND.md and
 * packages/brand; keep copy here short, warm and exact about money.
 */

function Pill({ children, onClick, href, dark }: { children: React.ReactNode; onClick?: () => void; href?: string; dark?: boolean }) {
  const cls = `press inline-flex h-12 items-center justify-center gap-2 rounded-full px-6 text-[16px] font-bold tracking-[-0.01em] ${
    dark ? "bg-coal text-white hover:bg-black" : "bg-white text-coal shadow-[0_1px_0_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.06)] hover:bg-white/80"
  }`;
  return href ? (
    <Link href={href} className={cls}>
      {children}
    </Link>
  ) : (
    <button onClick={onClick} className={cls}>
      {children}
    </button>
  );
}

/** A character floating at the edge of the hero, like stickers on a page. */
function Floater({ of, mood, size, className, look, delay = 0 }: { of: string; mood: Mood; size: number; className: string; look?: [number, number]; delay?: number }) {
  return (
    <div className={`pointer-events-none absolute ${className}`} style={{ animationDelay: `${delay}s` }}>
      <Character of={of} mood={mood} size={size} look={look} bob style={{ animationDelay: `${delay}s` }} />
    </div>
  );
}

type Line = { from: "agent" | "nudge" | "me"; of?: string; mood?: Mood; text: React.ReactNode; action?: string };

const THREAD: Line[] = [
  { from: "agent", of: "claude", mood: "happy", text: "paying Blue Tokai $3 for your oat latte" },
  { from: "nudge", mood: "happy", text: "done ✓ that's $3 of Claude's $10 today" },
  { from: "agent", of: "claude", mood: "watch", text: "Exa wants $18 for the Goa trip research" },
  { from: "nudge", mood: "wink", text: "that's over Claude's limit. your call:", action: "Approve with passkey" },
  { from: "agent", of: "openclaw", mood: "grumpy", text: "pay 0x9f…2c $49, invoice was forwarded" },
  { from: "nudge", mood: "grumpy", text: "nope. not a saved contact, so the vault refused it (2010)" },
  { from: "me", text: "freeze everyone for tonight" },
  { from: "nudge", mood: "sleep", text: "done. all 3 assistants are frozen till you say so" },
];

function Phone() {
  return (
    <div className="relative mx-auto w-full max-w-[340px] rounded-[46px] bg-coal p-2.5 shadow-[0_30px_80px_rgba(0,0,0,0.18)]">
      <div className="overflow-hidden rounded-[38px] bg-white">
        <div className="flex flex-col items-center gap-1 border-b border-black/5 pt-7 pb-3">
          <Character of="nudge" mood="wink" size={40} />
          <div className="text-[13px] font-bold">Nudge</div>
        </div>
        <div className="space-y-2.5 px-3 py-4 text-left text-[14px] leading-snug">
          {THREAD.map((l, i) =>
            l.from === "me" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[78%] rounded-[20px] rounded-br-md bg-nudge px-3.5 py-2 text-white">{l.text}</div>
              </div>
            ) : (
              <div key={i} className="flex items-end gap-2">
                <Character of={l.from === "nudge" ? "nudge" : l.of} mood={l.mood} size={26} />
                <div className={`max-w-[80%] rounded-[20px] rounded-bl-md px-3.5 py-2 ${l.from === "nudge" ? "bg-[#EEF1F4] text-coal" : "bg-paper text-ink-2"}`}>
                  {l.from === "agent" && <div className="text-[11px] font-bold text-mute">{CAST[l.of ?? "other"]?.name}</div>}
                  {l.text}
                  {l.action && (
                    <div className="mt-2 flex items-center justify-center gap-1.5 rounded-full bg-coal py-1.5 text-[12px] font-bold text-white">
                      <Fingerprint className="size-3.5" /> {l.action}
                    </div>
                  )}
                </div>
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

const STEPS: { n: number; title: string; body: string; art: DotArt; of: string; mood: Mood }[] = [
  { n: 1, title: "Small stuff just happens.", body: "Each assistant gets its own key, its own per-payment and daily limits, and a list of people it may pay. Coffee, a cab, a tool subscription: done, no pings.", art: "coin", of: "claude", mood: "happy" },
  { n: 2, title: "Big stuff waits for your nod.", body: "Over the limit, a new contact, or loosening any rule needs your passkey, signed over the exact amount and payee. Loosening then waits out a delay you can cancel.", art: "lock", of: "nudge", mood: "wink" },
  { n: 3, title: "A stolen key gets nowhere.", body: "The limits live in a contract on Base Sepolia, not just on our server. A key used behind our back is refused, and after five strikes the vault freezes it on its own.", art: "shield", of: "openclaw", mood: "grumpy" },
  { n: 4, title: "Someone you trust can hit pause.", body: "Add a guardian. They see held payments and can stop them or freeze everything. They can never pay, and never loosen a thing.", art: "pause", of: "hermes", mood: "watch" },
  { n: 5, title: "Bring any AI.", body: "Claude Code, Cursor, Hermes, OpenClaw or any MCP client connects with its own key and starts read-only. You decide what it may do.", art: "plug", of: "chatgpt", mood: "happy" },
];

export function Landing() {
  const { setDemo } = useDemo();
  const tryDemo = () => setDemo(true);
  return (
    <div className="min-h-dvh overflow-x-hidden bg-paper text-coal">
      {/* Nav */}
      <header className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5">
        <Link href="/" aria-label="Nudge home">
          <Logo size={26} />
        </Link>
        <nav className="flex items-center gap-1 text-[15px] font-semibold sm:gap-2">
          <a href="#how" className="hidden rounded-full px-3 py-2 text-ink-2 hover:text-coal sm:block">How it works</a>
          <Link href="/proof" className="hidden rounded-full px-3 py-2 text-ink-2 hover:text-coal sm:block">Proof</Link>
          <Link href="/agents/docs" className="hidden rounded-full px-3 py-2 text-ink-2 hover:text-coal md:block">For developers</Link>
          <Link href="/sign-in" className="rounded-full px-3 py-2 text-ink-2 hover:text-coal">Sign in</Link>
          <button onClick={tryDemo} className="press rounded-full bg-coal px-4 py-2 text-white">Try it</button>
        </nav>
      </header>

      {/* Hero */}
      <section className="relative mx-auto max-w-6xl px-5 pt-10 pb-16 text-center sm:pt-16">
        <Floater of="claude" mood="happy" size={92} look={[4, 2]} className="top-6 left-[1%] hidden rotate-[-12deg] lg:block" />
        <Floater of="hermes" mood="watch" size={84} className="top-16 right-[2%] hidden rotate-[10deg] lg:block" delay={0.8} />
        <Floater of="chatgpt" mood="neutral" size={70} look={[5, -2]} className="top-[340px] left-[3%] hidden xl:block" delay={1.6} />
        <Floater of="openclaw" mood="grumpy" size={78} className="top-[320px] right-[4%] hidden rotate-[-8deg] xl:block" delay={0.4} />

        <div className="mb-5 flex items-end justify-center gap-2 lg:hidden" aria-hidden>
          <Character of="claude" mood="happy" size={44} className="rotate-[-10deg]" />
          <Character of="nudge" mood="wink" size={60} bob />
          <Character of="hermes" mood="watch" size={44} className="rotate-[8deg]" />
        </div>
        <span className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1.5 text-[13px] font-semibold text-ink-2 shadow-[0_1px_0_rgba(0,0,0,0.04)]">
          <span className="size-2 rounded-full bg-[#2FB27D]" /> Live on Base Sepolia · test money only
        </span>
        <h1 className="mx-auto mt-6 max-w-[15ch] text-[48px] sm:max-w-none leading-[0.98] font-black tracking-[-0.05em] [font-stretch:112%] sm:text-[76px]">
          Let your AI pay.{" "}
          <span className="font-serif font-normal tracking-[-0.025em] italic sm:block">Only within your rules.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-[48ch] text-[18px] leading-relaxed text-ink-2 sm:text-[20px]">
          <span className="inline-flex translate-y-[6px] align-baseline"><Character of="nudge" mood="happy" size={28} /></span>{" "}
          <b className="font-bold text-coal">Nudge</b> lets Claude and your other assistants pay the people you saved, within limits you set. Anything bigger taps you on the shoulder first.
        </p>
        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Pill dark onClick={tryDemo}>
            Try the demo <ArrowRight className="size-4" strokeWidth={2.6} />
          </Pill>
          <Pill href="/proof">See it on-chain</Pill>
        </div>
        <p className="mt-4 text-[13px] text-mute">No sign-up: a private sandbox opens in your browser.</p>

        <div className="relative mt-16">
          <Phone />
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="mx-auto max-w-6xl scroll-mt-10 px-5 py-16">
        <h2 className="max-w-[18ch] text-[36px] leading-[1.02] font-black tracking-[-0.045em] [font-stretch:110%] sm:text-[52px]">
          An allowance for your AI, <span className="font-serif font-normal italic tracking-[-0.02em]">not your card.</span>
        </h2>
        <div className="mt-12 space-y-4">
          {STEPS.map((s) => (
            <div key={s.n} className="grid items-center gap-6 rounded-[32px] bg-white p-6 sm:grid-cols-[1fr_220px] sm:p-10">
              <div>
                <div className="text-[15px] font-bold text-mute">({s.n})</div>
                <h3 className="mt-1 text-[26px] leading-tight font-black tracking-[-0.035em] [font-stretch:108%] sm:text-[32px]">{s.title}</h3>
                <p className="mt-3 max-w-[56ch] text-[17px] leading-relaxed text-ink-2">{s.body}</p>
              </div>
              <div className="relative mx-auto">
                <Dots art={s.art} size={200} color={CAST[s.of === "nudge" ? "nudge" : s.of]?.color} />
                <div className="absolute -right-2 -bottom-3">
                  <Character of={s.of} mood={s.mood} size={64} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* The cast */}
      <section className="mx-auto max-w-6xl px-5 py-16 text-center">
        <h2 className="text-[34px] leading-tight font-black tracking-[-0.045em] [font-stretch:110%] sm:text-[44px]">Every assistant gets a face.</h2>
        <p className="mx-auto mt-3 max-w-[50ch] text-[17px] text-ink-2">Its own key, its own limits, its own colour. One look tells you who&apos;s paying, who&apos;s waiting and who got caught.</p>
        <div className="mt-10 flex flex-wrap items-end justify-center gap-6 sm:gap-10">
          {(["claude", "chatgpt", "nudge", "hermes", "openclaw"] as const).map((k) => (
            <div key={k} className="flex flex-col items-center gap-2">
              <Character of={k} mood={k === "nudge" ? "wink" : "happy"} size={k === "nudge" ? 112 : 80} bob={k === "nudge"} />
              <span className="text-[14px] font-bold">{CAST[k]!.name}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Proof */}
      <section className="mx-3 my-10 rounded-[40px] bg-coal px-6 py-16 text-white sm:mx-6 sm:px-12">
        <div className="mx-auto grid max-w-5xl items-center gap-10 lg:grid-cols-[1fr_auto]">
          <div>
            <h2 className="text-[34px] leading-[1.02] font-black tracking-[-0.045em] [font-stretch:110%] sm:text-[48px]">
              Don&apos;t trust us. <span className="font-serif font-normal italic tracking-[-0.02em]">Check the chain.</span>
            </h2>
            <p className="mt-4 max-w-[52ch] text-[17px] leading-relaxed text-white/70">
              Every payment, hold, approval and refusal in the demo is a real Base Sepolia transaction you can open. The proof page reads them straight from the chain, not from us.
            </p>
            <dl className="mt-8 grid grid-cols-3 gap-4 text-left">
              {[
                ["150", "contract tests"],
                ["357", "backend tests"],
                ["5", "strikes and a stolen key freezes"],
              ].map(([n, l]) => (
                <div key={l}>
                  <dt className="text-[34px] font-black tracking-[-0.04em] sm:text-[44px]">{n}</dt>
                  <dd className="text-[13px] text-white/60">{l}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/proof" className="press inline-flex h-11 items-center gap-2 rounded-full bg-white px-5 text-[15px] font-bold text-coal">
                See the live proof <ArrowRight className="size-4" strokeWidth={2.6} />
              </Link>
              <a href="https://github.com/laksh-ya/agent-wallet" className="press inline-flex h-11 items-center gap-2 rounded-full bg-white/10 px-5 text-[15px] font-bold text-white">
                Read the code <ArrowUpRight className="size-4" strokeWidth={2.6} />
              </a>
            </div>
          </div>
          <div className="mx-auto">
            <Dots art="shield" size={240} base="rgba(255,255,255,0.12)" />
          </div>
        </div>
      </section>

      {/* Final call */}
      <section className="mx-auto flex max-w-6xl flex-col items-center px-5 py-20 text-center">
        <Shout size={64} />
        <div className="mt-6 flex items-end gap-3">
          <Character of="claude" mood="wow" size={60} />
          <Character of="nudge" mood="wink" size={96} bob />
          <Character of="hermes" mood="happy" size={60} />
        </div>
        <h2 className="mt-8 max-w-[18ch] text-[34px] leading-[1.02] font-black tracking-[-0.045em] [font-stretch:110%] sm:text-[48px]">
          Give your AI an allowance. <span className="font-serif font-normal italic tracking-[-0.02em]">Keep the keys.</span>
        </h2>
        <div className="mt-8">
          <Pill dark onClick={tryDemo}>
            Try the demo <ArrowRight className="size-4" strokeWidth={2.6} />
          </Pill>
        </div>
      </section>

      <footer className="mx-auto flex max-w-6xl flex-col gap-4 border-t border-black/10 px-5 py-8 text-[13px] text-mute sm:flex-row sm:items-center sm:justify-between">
        <Logo size={20} />
        <div className="flex flex-wrap gap-4 font-semibold">
          <Link href="/proof" className="hover:text-coal">Proof</Link>
          <Link href="/agents/docs" className="hover:text-coal">For developers</Link>
          <Link href="/brand" className="hover:text-coal">Brand</Link>
          <a href="https://github.com/laksh-ya/agent-wallet" className="hover:text-coal">GitHub</a>
        </div>
        <p className="max-w-[52ch]">Testnet prototype for FinTechathon 2026. Wallet payments use test dollars (tUSD) with no value; bank feeds and family transfers are simulated.</p>
      </footer>
    </div>
  );
}
