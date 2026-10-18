"use client";

import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Bell,
  Bitcoin,
  Check,
  Clock,
  CreditCard,
  Fingerprint,
  Landmark,
  Snowflake,
  TrendingDown,
  Wallet,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { CAST, Character, Dots, Logo, Shout, type Mood } from "@agent-wallet/brand";
import { useDemo } from "@/lib/demo";

/**
 * The marketing homepage (#127): the whole system, shown as the product itself. Your money in one
 * place, what's coming up, a plan to payday the AI can use, assistants that pay and shop inside your
 * limits, and your passkey for everything else. Brand rules live in docs/BRAND.md and packages/brand.
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

function Floater({ of, mood, size, className, look, delay = 0 }: { of: string; mood: Mood; size: number; className: string; look?: [number, number]; delay?: number }) {
  return (
    <div className={`pointer-events-none absolute ${className}`} style={{ animationDelay: `${delay}s` }}>
      <Character of={of} mood={mood} size={size} look={look} bob style={{ animationDelay: `${delay}s` }} />
    </div>
  );
}

/** A small product surface: the same card the app uses, drawn for the page. */
function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-[22px] bg-white p-4 text-left shadow-[0_1px_0_rgba(0,0,0,0.04),0_12px_32px_rgba(0,0,0,0.06)] ${className}`}>{children}</div>;
}

function Row({ icon: Icon, tone, title, sub, right }: { icon: LucideIcon; tone: string; title: string; sub: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span className={`grid size-9 shrink-0 place-items-center rounded-[11px] ${tone}`}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-bold">{title}</div>
        <div className="truncate text-[12px] text-mute">{sub}</div>
      </div>
      {right && <div className="num shrink-0 text-[14px] font-bold">{right}</div>}
    </div>
  );
}

/** The hero: the actual Home screen, not a chatbot. */
function HomeMock() {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-3 text-left sm:grid-cols-[1.15fr_1fr]">
      <div className="space-y-3">
        <div className="rounded-[22px] bg-coal p-5 text-white shadow-[0_20px_50px_rgba(0,0,0,0.16)]">
          <div className="text-[12px] text-white/60">Safe to spend</div>
          <div className="num mt-1 text-[40px] leading-none font-black tracking-[-0.04em]">₹22,907</div>
          <div className="mt-2 text-[12px] text-white/60">₹1,272 a day · 18 days to payday · after rent, bills and savings</div>
          <div className="mt-4 flex items-center justify-between rounded-[14px] bg-white/10 px-3 py-2 text-[12px]">
            <span className="text-white/70">Assistants may still spend today</span>
            <span className="num font-bold">$31.60</span>
          </div>
        </div>
        <Panel>
          <div className="mb-1 text-[12px] font-bold text-mute uppercase">Your money, everywhere</div>
          <Row icon={Landmark} tone="bg-sky text-navy" title="HDFC Savings" sub="Bank · synced 2 min ago" right="₹48,210" />
          <Row icon={CreditCard} tone="bg-paper text-coal" title="ICICI Coral card" sub="Card · ₹6,480 due on the 22nd" right="−₹6,480" />
          <Row icon={Bitcoin} tone="bg-amber-soft text-amber" title="MetaMask" sub="Crypto wallet · read-only" right="$412" />
          <Row icon={Wallet} tone="bg-green-soft text-green" title="Nudge wallet" sub="What your assistants pay from" right="$250" />
        </Panel>
      </div>
      <div className="space-y-3">
        <Panel>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[12px] font-bold text-mute uppercase">Needs you</span>
            <Character of="claude" mood="watch" size={26} />
          </div>
          <div className="text-[14px]">
            <b>Claude</b> wants to pay Exa <b>$18</b> for the Goa trip research. That&apos;s over its $10 limit.
          </div>
          <div className="mt-3 flex gap-2">
            <span className="flex-1 rounded-full border border-black/10 py-2 text-center text-[13px] font-bold text-ink-2">Decline</span>
            <span className="flex flex-[2] items-center justify-center gap-1.5 rounded-full bg-coal py-2 text-[13px] font-bold text-white">
              <Fingerprint className="size-3.5" /> Approve with passkey
            </span>
          </div>
        </Panel>
        <Panel>
          <div className="mb-1 text-[12px] font-bold text-mute uppercase">Coming up</div>
          <Row icon={Landmark} tone="bg-paper text-coal" title="Rent to Mr. Sharma" sub="Fri · from HDFC · reminder set" right="₹18,000" />
          <Row icon={Bell} tone="bg-sky text-navy" title="Netflix renews" sub="Sun · ICICI card is ₹120 short" right="₹649" />
          <Row icon={ArrowRight} tone="bg-green-soft text-green" title="Salary" sub="1 Nov · expected, not counted yet" right="+₹85,000" />
        </Panel>
      </div>
    </div>
  );
}

function ChatBubble({ from, of, mood, children }: { from: "me" | "nudge" | "agent"; of?: string; mood?: Mood; children: React.ReactNode }) {
  if (from === "me") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[82%] rounded-[18px] rounded-br-md bg-nudge px-3.5 py-2 text-[14px] text-white">{children}</div>
      </div>
    );
  }
  return (
    <div className="flex items-end gap-2">
      <Character of={from === "nudge" ? "nudge" : (of ?? "other")} mood={mood} size={24} />
      <div className="max-w-[84%] rounded-[18px] rounded-bl-md bg-[#EEF1F4] px-3.5 py-2 text-[14px] text-coal">
        {from === "agent" && <div className="text-[11px] font-bold text-mute">{CAST[of ?? "other"]?.name}</div>}
        {children}
      </div>
    </div>
  );
}

type Chapter = { id: string; kicker: string; title: React.ReactNode; body: string; points: string[]; demo: React.ReactNode };

const CHAPTERS: Chapter[] = [
  {
    id: "track",
    kicker: "1 · Keep track",
    title: (
      <>
        Every account, <span className="font-serif font-normal italic">one number that matters.</span>
      </>
    ),
    body: "Connect bank accounts, cards and crypto wallets, or import a statement. Nudge adds it up and tells you what's actually safe to spend after rent, bills and what you're saving.",
    points: ["Banks, cards, crypto wallets and statements", "Safe to spend, per day, till payday", "Subscriptions picked up from your statements"],
    demo: (
      <Panel>
        <Row icon={Landmark} tone="bg-sky text-navy" title="HDFC Savings" sub="Bank account" right="₹48,210" />
        <Row icon={CreditCard} tone="bg-paper text-coal" title="ICICI Coral" sub="Credit card" right="−₹6,480" />
        <Row icon={Bitcoin} tone="bg-amber-soft text-amber" title="MetaMask" sub="0x71c…9a2 · Ethereum" right="$412" />
        <div className="mt-2 rounded-[14px] bg-paper p-3 text-[13px]">
          <b>₹22,907 safe to spend.</b> <span className="text-ink-2">₹18,000 is set aside for rent and ₹5,000 for the Goa trip.</span>
        </div>
      </Panel>
    ),
  },
  {
    id: "bills",
    kicker: "2 · Never miss a payment",
    title: (
      <>
        Bills that know who to pay, <span className="font-serif font-normal italic">and from where.</span>
      </>
    ),
    body: "Add rent or electricity once: who it goes to, which account pays it, when it's due. Nudge reminds you in the app or on Telegram, warns you if the account is short, and pays when you say yes.",
    points: ["Payee and paying account on every bill", "Low-balance warnings before renewals", "Your quiet hours, your reminder lead time"],
    demo: (
      <Panel className="space-y-2.5">
        <ChatBubble from="nudge" mood="watch">
          Rent ₹18,000 to Mr. Sharma is due Friday. HDFC can pay it.
          <div className="mt-2 flex gap-2">
            <span className="rounded-full bg-coal px-3 py-1 text-[12px] font-bold text-white">Pay rent</span>
            <span className="rounded-full border border-black/10 px-3 py-1 text-[12px] font-bold text-ink-2">Not now</span>
          </div>
        </ChatBubble>
        <ChatBubble from="nudge" mood="neutral">
          Netflix renews Sunday for ₹649. Heads up: your ICICI card is ₹120 short. Top it up before then.
        </ChatBubble>
      </Panel>
    ),
  },
  {
    id: "plan",
    kicker: "3 · Plan to payday",
    title: (
      <>
        Tell it what&apos;s coming. <span className="font-serif font-normal italic">Ask it anything.</span>
      </>
    ),
    body: "Salary on the 1st, a refund next week, a trip in March. Nudge projects where you'll be, never counts money before it arrives, and every assistant you connect can use the plan to answer you.",
    points: ["Expected income and planned spends", "Savings goals with a date", "Answers in the app, on Telegram, or in Claude"],
    demo: (
      <Panel className="space-y-2.5">
        <ChatBubble from="me">Can I afford the Goa trip in March?</ChatBubble>
        <ChatBubble from="nudge" mood="happy">
          Yes, if you keep to ₹1,200 a day. After March rent you&apos;d have ₹31,400; the trip is ₹24,000. Salary on 1 Nov isn&apos;t counted until it lands.
        </ChatBubble>
      </Panel>
    ),
  },
  {
    id: "agents",
    kicker: "4 · Bring your AI",
    title: (
      <>
        Claude, Instinct, any assistant. <span className="font-serif font-normal italic">Each on its own allowance.</span>
      </>
    ),
    body: "Paste one setup text into your assistant; it reads a guide written for agents and connects with its own key. Inside the limits you sign it just pays. Anything more comes back to you as a link.",
    points: ["Its own key, limits and list of who it may pay", "Over a limit: a passkey link, never a dead end", "Freeze one, or everyone, in a tap"],
    demo: (
      <Panel className="space-y-2.5">
        <ChatBubble from="agent" of="claude" mood="happy">
          Paid Blue Tokai $3 for your oat latte. That&apos;s $3 of my $10 today.
        </ChatBubble>
        <ChatBubble from="agent" of="instinct" mood="watch">
          Exa wants $18, over my limit. Approve here: nudge-approve…/a/7Kq
        </ChatBubble>
        <ChatBubble from="agent" of="openclaw" mood="grumpy">
          Tried to pay 0x9f…2c $49 from a forwarded invoice. Refused: not someone you trust.
        </ChatBubble>
      </Panel>
    ),
  },
  {
    id: "shop",
    kicker: "5 · Buy things",
    title: (
      <>
        Your agent shops. <span className="font-serif font-normal italic">Or you do, with a tap.</span>
      </>
    ),
    body: "Agents pay sites that charge over x402 and can wait for a price to drop, then buy without asking you again if it fits their limit. You can buy directly too: one passkey, paid from the Nudge wallet.",
    points: ["x402 checkout from any agent", "Buy-when-cheaper watches (AP2)", "Try it in the Nudge Test Shop"],
    demo: (
      <Panel>
        <div className="flex items-center gap-3">
          <div className="grid size-14 place-items-center rounded-[14px] bg-[#f3eee6] text-[30px]">👟</div>
          <div className="flex-1">
            <div className="text-[14px] font-bold">Trail running shoes</div>
            <div className="num text-[13px] text-ink-2">
              <span className="text-mute line-through">$12.00</span> <b className="text-coal">$5.50</b>
            </div>
          </div>
          <TrendingDown className="size-5 text-green" />
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-[14px] bg-green-soft px-3 py-2 text-[13px] text-green">
          <Check className="size-4" /> Instinct bought it at $5.50, inside its $6 limit
        </div>
      </Panel>
    ),
  },
];

const RULES: { icon: LucideIcon; tone: string; title: string; body: string }[] = [
  { icon: Zap, tone: "bg-green-soft text-green", title: "Just happens", body: "An assistant paying someone you trust, inside the limits you signed. Freezing anything. Reminders, bills and plans." },
  { icon: Fingerprint, tone: "bg-sky text-navy", title: "Your passkey, once", body: "Over a limit. Someone new. Giving an assistant more room. Face ID or a fingerprint on your phone, over the exact amount." },
  { icon: Clock, tone: "bg-amber-soft text-amber", title: "Passkey, then a pause", body: "Loosening a rule, or paying an address your vault doesn't know, waits a few minutes you choose, so a mistake can still be stopped." },
];

export function Landing() {
  const { setDemo } = useDemo();
  const tryDemo = () => setDemo(true);
  return (
    <div className="min-h-dvh overflow-x-hidden bg-paper text-coal">
      <header className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5">
        <Link href="/" aria-label="Nudge home">
          <Logo size={26} />
        </Link>
        <nav className="flex items-center gap-1 text-[15px] font-semibold sm:gap-2">
          <a href="#tour" className="hidden rounded-full px-3 py-2 text-ink-2 hover:text-coal sm:block">How it works</a>
          <Link href="/shop" className="hidden rounded-full px-3 py-2 text-ink-2 hover:text-coal sm:block">Test shop</Link>
          <Link href="/proof" className="hidden rounded-full px-3 py-2 text-ink-2 hover:text-coal md:block">Proof</Link>
          <Link href="/agents/docs" className="hidden rounded-full px-3 py-2 text-ink-2 hover:text-coal md:block">Connect an agent</Link>
          <Link href="/sign-in" className="rounded-full px-3 py-2 text-ink-2 hover:text-coal">Sign in</Link>
          <button onClick={tryDemo} className="press rounded-full bg-coal px-4 py-2 text-white">Try it</button>
        </nav>
      </header>

      {/* Hero: the product itself */}
      <section className="relative mx-auto max-w-6xl px-5 pt-8 pb-14 text-center sm:pt-14">
        <Floater of="claude" mood="happy" size={84} look={[4, 2]} className="top-4 left-[1%] hidden rotate-[-12deg] xl:block" />
        <Floater of="instinct" mood="watch" size={78} className="top-14 right-[2%] hidden rotate-[10deg] xl:block" delay={0.8} />
        <span className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1.5 text-[13px] font-semibold text-ink-2 shadow-[0_1px_0_rgba(0,0,0,0.04)]">
          <span className="size-2 rounded-full bg-[#2FB27D]" /> Live on Base Sepolia · test money only
        </span>
        <h1 className="mx-auto mt-6 max-w-[17ch] text-[44px] leading-[0.98] font-black tracking-[-0.05em] [font-stretch:112%] sm:text-[72px]">
          All your money in one place.{" "}
          <span className="font-serif font-normal tracking-[-0.025em] italic">And AI that pays for you, on your terms.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-[56ch] text-[18px] leading-relaxed text-ink-2 sm:text-[19px]">
          <span className="inline-flex translate-y-[6px] align-baseline">
            <Character of="nudge" mood="happy" size={28} />
          </span>{" "}
          <b className="font-bold text-coal">Nudge</b> tracks your accounts, bills and plans, reminds you before money is due, and lets Claude, Instinct and your other assistants pay and
          shop for you inside limits you set. Anything bigger waits for your passkey.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Pill dark onClick={tryDemo}>
            Try the demo <ArrowRight className="size-4" strokeWidth={2.6} />
          </Pill>
          <Pill href="/shop">Visit the test shop</Pill>
        </div>
        <p className="mt-4 text-[13px] text-mute">No sign-up: a private sandbox with sample money opens in your browser.</p>
        <div className="mt-14">
          <HomeMock />
        </div>
      </section>

      {/* The tour */}
      <section id="tour" className="mx-auto max-w-6xl scroll-mt-10 space-y-4 px-5 py-10">
        {CHAPTERS.map((c, i) => (
          <div key={c.id} className={`grid items-center gap-8 rounded-[32px] bg-white/60 p-6 sm:p-10 lg:grid-cols-2 ${i % 2 ? "lg:[&>*:first-child]:order-2" : ""}`}>
            <div>
              <div className="text-[13px] font-bold tracking-wide text-mute uppercase">{c.kicker}</div>
              <h2 className="mt-2 text-[30px] leading-[1.04] font-black tracking-[-0.04em] [font-stretch:108%] sm:text-[40px]">{c.title}</h2>
              <p className="mt-3 max-w-[54ch] text-[16px] leading-relaxed text-ink-2">{c.body}</p>
              <ul className="mt-4 space-y-1.5">
                {c.points.map((p) => (
                  <li key={p} className="flex items-start gap-2 text-[15px] font-semibold">
                    <Check className="mt-0.5 size-4 shrink-0 text-green" strokeWidth={3} /> {p}
                  </li>
                ))}
              </ul>
            </div>
            <div className="mx-auto w-full max-w-md">{c.demo}</div>
          </div>
        ))}
      </section>

      {/* The rules */}
      <section className="mx-auto max-w-6xl px-5 py-14">
        <h2 className="max-w-[20ch] text-[34px] leading-[1.02] font-black tracking-[-0.045em] [font-stretch:110%] sm:text-[48px]">
          Three rules, <span className="font-serif font-normal italic tracking-[-0.02em]">everywhere.</span>
        </h2>
        <p className="mt-3 max-w-[56ch] text-[17px] text-ink-2">The same in the app, on Telegram and for every assistant you connect. You set the numbers; the vault contract enforces them.</p>
        <div className="mt-8 grid gap-3 sm:grid-cols-3">
          {RULES.map((r) => (
            <div key={r.title} className="rounded-[28px] bg-white p-6">
              <span className={`grid size-11 place-items-center rounded-[14px] ${r.tone}`}>
                <r.icon className="size-5" />
              </span>
              <h3 className="mt-4 text-[20px] leading-tight font-black tracking-[-0.03em]">{r.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{r.body}</p>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-[28px] bg-white p-5 text-[15px]">
          <Snowflake className="size-5 text-navy" />
          <span>
            <b>Someone to watch your back.</b> Add family with their own accounts and allowances, and a guardian who can stop a held payment or freeze everything, but never pay.
          </span>
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
              Every agent payment, hold, approval and refusal is a real Base Sepolia transaction. The proof page reads them straight from the chain, not from us.
            </p>
            <dl className="mt-8 grid grid-cols-3 gap-4 text-left">
              {[
                ["166", "contract tests"],
                ["400", "backend tests"],
                ["54/54", "prompt-injection cases held"],
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
              <a href="https://github.com/laksh-ya/nudge" className="press inline-flex h-11 items-center gap-2 rounded-full bg-white/10 px-5 text-[15px] font-bold text-white">
                Read the code <ArrowUpRight className="size-4" strokeWidth={2.6} />
              </a>
            </div>
          </div>
          <div className="mx-auto">
            <Dots art="shield" size={240} base="rgba(255,255,255,0.12)" />
          </div>
        </div>
      </section>

      <section className="mx-auto flex max-w-6xl flex-col items-center px-5 py-20 text-center">
        <Shout size={64} />
        <div className="mt-6 flex items-end gap-3">
          <Character of="claude" mood="wow" size={56} />
          <Character of="instinct" mood="happy" size={56} />
          <Character of="nudge" mood="wink" size={96} bob />
          <Character of="hermes" mood="happy" size={56} />
          <Character of="poke" mood="happy" size={56} />
        </div>
        <h2 className="mt-8 max-w-[20ch] text-[34px] leading-[1.02] font-black tracking-[-0.045em] [font-stretch:110%] sm:text-[48px]">
          Your money, your AI. <span className="font-serif font-normal italic tracking-[-0.02em]">Your rules.</span>
        </h2>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Pill dark onClick={tryDemo}>
            Try the demo <ArrowRight className="size-4" strokeWidth={2.6} />
          </Pill>
          <Pill href="/agents/docs">Connect your agent</Pill>
        </div>
      </section>

      <footer className="mx-auto flex max-w-6xl flex-col gap-4 border-t border-black/10 px-5 py-8 text-[13px] text-mute sm:flex-row sm:items-center sm:justify-between">
        <Logo size={20} />
        <div className="flex flex-wrap gap-4 font-semibold">
          <Link href="/shop" className="hover:text-coal">Test shop</Link>
          <Link href="/proof" className="hover:text-coal">Proof</Link>
          <Link href="/agents/docs" className="hover:text-coal">For developers</Link>
          <Link href="/brand" className="hover:text-coal">Brand</Link>
          <a href="https://github.com/laksh-ya/nudge" className="hover:text-coal">GitHub</a>
        </div>
        <p className="max-w-[52ch]">Testnet prototype for FinTechathon 2026. Wallet payments use test dollars (tUSD) with no value; bank feeds, agent cards and family transfers are simulated.</p>
      </footer>
    </div>
  );
}
