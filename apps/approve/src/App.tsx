import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { Check, Clock, Landmark, LoaderCircle, Lock, ShieldCheck, TriangleAlert, Wallet, X } from "lucide-react";
import { api } from "@agent-wallet/backend/api";
import { formatMoney, type Currency } from "@agent-wallet/domain";

const WEB_URL = import.meta.env.VITE_WEB_URL ?? "http://localhost:3000";

function tokenFromPath() {
  const m = window.location.pathname.match(/^\/a\/([A-Za-z0-9]+)$/);
  return m?.[1] ?? null;
}

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function Wordmark() {
  return (
    <span className="text-[18px] leading-none font-extrabold tracking-[-0.035em] [font-stretch:110%]">
      <span className="text-navy">agent</span>
      <span className="text-cyan">wallet</span>
    </span>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col px-4 pb-[max(16px,env(safe-area-inset-bottom))]">
      <header className="flex h-14 items-center justify-between">
        <Wordmark />
        <span className="flex items-center gap-1.5 rounded-md bg-amber-soft px-2 py-1 text-micro font-semibold text-amber">
          Test mode
        </span>
      </header>
      {children}
      <a href={WEB_URL} className="mt-6 text-center text-label font-semibold text-cyan-ink">
        Back to agent wallet
      </a>
    </div>
  );
}

export function App() {
  const token = tokenFromPath();
  const data = useQuery(api.approvals.get, token ? { token } : "skip");
  const decide = useMutation(api.approvals.decide);
  const now = useNow();
  const [busy, setBusy] = useState(false);

  if (!token || data === null) {
    return (
      <Frame>
        <div className="rise mt-16 rounded-2xl bg-white p-6 text-center shadow-sm">
          <TriangleAlert className="mx-auto size-8 text-amber" />
          <h1 className="mt-3 text-head font-semibold">This link isn't valid</h1>
          <p className="mt-1 text-body text-mute">Ask your assistant for a new one.</p>
        </div>
      </Frame>
    );
  }
  if (data === undefined) {
    return (
      <Frame>
        <div className="mt-4 h-[420px] animate-pulse rounded-2xl bg-white" />
      </Frame>
    );
  }

  const currency = data.currency as Currency;
  const expired = data.expiresAt !== undefined && data.expiresAt <= now;
  const secs = data.expiresAt ? Math.max(0, Math.round((data.expiresAt - now) / 1000)) : null;
  const left =
    secs === null
      ? null
      : secs >= 3600
        ? `${Math.floor(secs / 3600)} hr ${Math.floor((secs % 3600) / 60)} min`
        : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  const open = data.state === "awaiting_approval" && !expired;
  const run = async (approve: boolean) => {
    setBusy(true);
    try {
      await decide({ token, approve });
    } finally {
      setBusy(false);
    }
  };

  if (data.state === "confirmed") {
    return (
      <Frame>
        <div className="mt-14 flex flex-col items-center text-center">
          <span className="pop grid size-20 place-items-center rounded-full bg-green text-white">
            <Check className="size-10" strokeWidth={3} />
          </span>
          <div className="figure rise mt-6 text-[40px] leading-[44px]">{formatMoney(data.amountMinor, currency, { cents: currency === "USDC" })}</div>
          <p className="rise mt-1 text-title text-ink-2">Paid to {data.payee?.name ?? data.title}</p>
          {data.rail !== "base-sepolia" && <p className="rise mt-3 text-label text-mute">Simulated payment. No real money moved.</p>}
        </div>
      </Frame>
    );
  }

  return (
    <Frame>
      <main className="rise mt-2 overflow-hidden rounded-2xl bg-white shadow-[0_2px_12px_rgba(0,41,112,0.06)]">
        <div className="px-5 pt-6 pb-5 text-center">
          <div className="text-body text-ink-2">{data.agent ? `${data.agent} wants to pay` : "You're paying"}</div>
          <div className="figure mt-1 text-[44px] leading-[48px] text-navy">
            {formatMoney(data.amountMinor, currency, { cents: currency === "USDC" })}
          </div>
          {data.payee && (
            <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-page py-1.5 pr-3 pl-1.5">
              <span className="grid size-7 place-items-center rounded-full bg-navy text-label font-bold text-white">
                {data.payee.name.slice(0, 1)}
              </span>
              <span className="text-body font-semibold">{data.payee.name}</span>
              {data.payee.trusted && <ShieldCheck className="size-4 text-green" aria-label="In your contacts" />}
            </div>
          )}
          {data.payee && <div className="num mt-1.5 text-label text-mute">{data.payee.handle}</div>}
        </div>

        <dl className="divide-y divide-line border-t border-line px-5 text-body">
          <Detail label="From">
            {data.rail === "handoff" ? (
              <span className="flex items-center gap-1.5"><Landmark className="size-4 text-mute" /> Bank account via UPI</span>
            ) : (
              <span className="flex items-center gap-1.5"><Wallet className="size-4 text-mute" /> Agent wallet</span>
            )}
          </Detail>
          {data.purpose && <Detail label="For">{data.purpose}</Detail>}
          {data.reason && <Detail label="Why you're asked">{data.reason}</Detail>}
          {left && (
            <Detail label="Expires">
              <span className={`num flex items-center gap-1.5 ${expired ? "text-red" : ""}`}>
                <Clock className="size-4 text-mute" /> {expired ? "Expired" : left}
              </span>
            </Detail>
          )}
        </dl>

        <div className="border-t border-line p-4">
          {open && data.rail === "handoff" && data.payee && /@/.test(data.payee.handle) && (
            <a
              href={`upi://pay?pa=${encodeURIComponent(data.payee.handle)}&pn=${encodeURIComponent(data.payee.name)}&am=${(data.amountMinor / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent(data.title)}`}
              className="press mb-2 flex h-11 items-center justify-center rounded-[10px] bg-sky text-body font-semibold text-navy"
            >
              Open in UPI app
            </a>
          )}
          {open ? (
            <div className="grid grid-cols-[1fr_2fr] gap-2">
              <button
                disabled={busy}
                onClick={() => run(false)}
                className="press flex h-12 items-center justify-center gap-1.5 rounded-[10px] border border-line text-title font-semibold text-ink-2 disabled:opacity-50"
              >
                <X className="size-4" /> Decline
              </button>
              <button
                disabled={busy}
                onClick={() => run(true)}
                className="press flex h-12 items-center justify-center gap-2 rounded-[10px] bg-navy text-title font-semibold text-white disabled:opacity-60"
              >
                {busy ? <LoaderCircle className="size-5 animate-spin" /> : <Check className="size-5" strokeWidth={2.5} />}
                Approve
              </button>
            </div>
          ) : data.state === "submitted" ? (
            <div className="flex h-12 items-center justify-center gap-2 rounded-[10px] bg-sky text-title font-semibold text-navy">
              <LoaderCircle className="size-5 animate-spin" /> Sending
            </div>
          ) : (
            <div className="flex h-12 items-center justify-center rounded-[10px] bg-page text-title font-semibold text-ink-2">
              {expired || data.state === "expired" ? "This request expired" : data.state === "cancelled" ? "Declined" : "Already handled"}
            </div>
          )}
        </div>
      </main>
      <p className="mt-4 flex items-center justify-center gap-1.5 text-label text-mute">
        <Lock className="size-3.5" /> Test mode. Passkey signing isn't connected yet.
      </p>
    </Frame>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <dt className="shrink-0 text-mute">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}
