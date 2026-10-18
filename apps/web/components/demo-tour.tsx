"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Bot, CalendarRange, ChevronLeft, ChevronRight, ExternalLink, Fingerprint, ShieldCheck, ShoppingBag, Sparkles, X } from "lucide-react";
import { EXPLORER, PROOF_TX, REFERENCE_VAULT, STOLEN_KEY_VAULT } from "@/lib/config";

const KEY = "aw-demo-tour-hidden";

const STEPS = [
  {
    icon: Sparkles,
    title: "This is your own sandbox",
    text: "Sample bank accounts, bills and spending, so you can try everything without signing up. Test dollars only; nothing here is real money. Your sandbox is private to you.",
    href: "/money",
    cta: "Look at the money",
  },
  {
    icon: Bot,
    title: "Connect any AI agent",
    text: "Agents → Connect an assistant → copy the setup text and paste it into Claude, Instinct or any MCP assistant. It connects itself, reads the guide written for agents and can answer anything about your money.",
    href: "/agents",
    cta: "Connect an agent",
  },
  {
    icon: Fingerprint,
    title: "Limits, then a passkey",
    text: "Give an agent a limit (say $2 a payment). Under it, it pays on its own. Over it, or to someone new, it sends you a link and you approve with your passkey. On-chain, the vault itself enforces the limit.",
    href: "/agents",
    cta: "Set a limit",
  },
  {
    icon: ShoppingBag,
    title: "Agents can shop: x402 and price drops",
    text: 'The Nudge Test Shop takes test dollars. Buy something yourself, or copy the line for your agent ("buy the trail shoes when they\'re under $6"): it watches the price and buys within its limits. In Seller view, run a sale and watch the order arrive.',
    href: "/shop",
    cta: "Open the test shop",
  },
  {
    icon: CalendarRange,
    title: "Plan, reminders and the chat",
    text: "Add your salary and planned spends to see where you'll be by payday; set reminders. Ask Nudge in the chat or on Telegram: \"will I make it to payday?\", \"remind me to pay rent on the 1st\".",
    href: "/plan",
    cta: "Open Plan",
  },
  {
    icon: ShieldCheck,
    title: "Proof on Base Sepolia",
    text: "Real transactions: a payment inside the limits, one approved with a passkey, and a stolen agent key refused by the contract.",
    href: `/proof?vault=${REFERENCE_VAULT}`,
    cta: "See the proof",
    txs: [
      { label: "Paid at once", tx: PROOF_TX.paidAtOnce },
      { label: "Approved by passkey", tx: PROOF_TX.approvedOnPhone },
      { label: "Stolen key refused", tx: PROOF_TX.stolenKeyRefused, vault: STOLEN_KEY_VAULT },
    ],
  },
];

/** A short walkthrough for anyone in a demo sandbox: what to try, in order. Dismissible. */
export function DemoTour() {
  const [hidden, setHidden] = useState(true);
  const [i, setI] = useState(0);
  useEffect(() => {
    try {
      setHidden(localStorage.getItem(KEY) === "1");
    } catch {
      setHidden(false);
    }
  }, []);
  if (hidden) return null;
  const s = STEPS[i]!;
  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem(KEY, "1");
    } catch {}
  };
  return (
    <section className="card rise border-l-4 border-cyan p-4" aria-labelledby="tour-title">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-sky text-navy">
          <s.icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-label font-semibold text-mute">
            Demo tour · {i + 1} of {STEPS.length}
          </div>
          <h2 id="tour-title" className="text-title font-semibold text-ink">
            {s.title}
          </h2>
          <p className="mt-1 text-body text-ink-2">{s.text}</p>
          {"txs" in s && s.txs && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-label font-semibold">
              {s.txs.map((t) => (
                <a key={t.tx} href={`${EXPLORER}/tx/${t.tx}`} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-cyan-ink">
                  {t.label} <ExternalLink className="size-3" />
                </a>
              ))}
            </div>
          )}
        </div>
        <button onClick={dismiss} aria-label="Hide the tour" className="press -m-1 grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-page">
          <X className="size-4" />
        </button>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button disabled={i === 0} onClick={() => setI(i - 1)} className="press grid size-9 place-items-center rounded-btn border border-line disabled:opacity-40" aria-label="Previous">
          <ChevronLeft className="size-4" />
        </button>
        <Link href={s.href} className="press flex h-9 flex-1 items-center justify-center rounded-btn bg-navy px-3 text-label font-semibold text-white">
          {s.cta}
        </Link>
        <button
          onClick={() => (i === STEPS.length - 1 ? dismiss() : setI(i + 1))}
          className="press flex h-9 items-center gap-1 rounded-btn border border-line px-3 text-label font-semibold text-navy"
        >
          {i === STEPS.length - 1 ? "Done" : "Next"} <ChevronRight className="size-4" />
        </button>
      </div>
    </section>
  );
}
