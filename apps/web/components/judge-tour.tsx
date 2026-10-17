"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ExternalLink, Fingerprint, ShieldX, X, Zap } from "lucide-react";
import { EXPLORER, PROOF_TX, REFERENCE_VAULT, STOLEN_KEY_VAULT } from "@/lib/config";

const KEY = "aw-tour-hidden";

const STEPS = [
  {
    icon: Zap,
    tone: "bg-green-soft text-green",
    title: "Small payment: paid at once",
    text: "Claude paid a saved contact $3 over MCP. Inside its limits, so the vault sent it straight away.",
    tx: PROOF_TX.paidAtOnce,
    proof: REFERENCE_VAULT,
  },
  {
    icon: Fingerprint,
    tone: "bg-amber-soft text-amber",
    title: "Over the limit: waits for the passkey",
    text: "Claude asked for $12, over its $10 limit. Nothing moved until the owner approved it with the passkey on their phone.",
    tx: PROOF_TX.approvedOnPhone,
    proof: REFERENCE_VAULT,
  },
  {
    icon: ShieldX,
    tone: "bg-red-soft text-red",
    title: "Stolen key: refused by the contract",
    text: "An agent key used directly, bypassing our server, tried $50. The vault refused it (code 2003), and froze the key after five refusals.",
    tx: PROOF_TX.stolenKeyRefused,
    proof: STOLEN_KEY_VAULT,
  },
];

/** Three real Base Sepolia transactions that show what the vault does, for anyone in a demo sandbox. */
export function JudgeTour() {
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    try {
      setHidden(localStorage.getItem(KEY) === "1");
    } catch {
      setHidden(false);
    }
  }, []);
  if (hidden) return null;
  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem(KEY, "1");
    } catch {}
  };
  return (
    <section className="card rise p-4" aria-labelledby="tour-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="tour-title" className="text-title font-semibold text-ink">
            See the vault enforce limits
          </h2>
          <p className="text-label text-mute">Three real transactions on Base Sepolia (test dollars). Each link opens BaseScan.</p>
        </div>
        <button onClick={dismiss} aria-label="Hide the tour" className="press -m-1 grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-page">
          <X className="size-4" />
        </button>
      </div>
      <ol className="mt-3 space-y-3">
        {STEPS.map((s, i) => (
          <li key={s.tx} className="flex gap-3">
            <span className={`grid size-9 shrink-0 place-items-center rounded-[10px] ${s.tone}`}>
              <s.icon className="size-[18px]" strokeWidth={2} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-body font-semibold">
                {i + 1}. {s.title}
              </div>
              <p className="text-label text-ink-2">{s.text}</p>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-label font-semibold">
                <a href={`${EXPLORER}/tx/${s.tx}`} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-cyan-ink">
                  <span className="num">{s.tx.slice(0, 10)}…</span> on BaseScan <ExternalLink className="size-3" />
                </a>
                <Link href={`/proof?vault=${s.proof}`} className="text-cyan-ink">
                  Vault record
                </Link>
              </div>
            </div>
          </li>
        ))}
      </ol>
      <Link href="/wallet" className="press mt-4 flex items-center justify-center rounded-btn bg-sky px-3 py-2.5 text-label font-semibold text-navy">
        Try it yourself: put this sandbox&apos;s wallet on-chain (about a minute)
      </Link>
    </section>
  );
}
