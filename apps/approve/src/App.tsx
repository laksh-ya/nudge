import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { Check, Clock, ExternalLink, Fingerprint, Landmark, LoaderCircle, Lock, ShieldCheck, TriangleAlert, Wallet, X } from "lucide-react";
import { api } from "@agent-wallet/backend/api";
import { actionDigest, describe, formatMoney, type Currency, type Op } from "@agent-wallet/domain";
import type { Address, Hex } from "viem";
import { createPasskey, inAppBrowser, passkeysSupported, signWithPasskey } from "./passkey";

const WEB_URL = import.meta.env.VITE_WEB_URL ?? "http://localhost:3000";

function route(): { kind: "approve" | "enrol"; token: string } | null {
  const m = window.location.pathname.match(/^\/(a|enrol)\/([A-Za-z0-9]+)$/);
  if (!m) return null;
  return { kind: m[1] === "a" ? "approve" : "enrol", token: m[2]! };
}

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function errorText(e: unknown) {
  const m = e instanceof Error ? e.message : String(e);
  if (/NotAllowedError|timed out|not allowed/i.test(m)) return "The passkey prompt was closed. Try again.";
  return (m.match(/Uncaught Error: ([^\n]+)/)?.[1] ?? m).slice(0, 160);
}

function Wordmark() {
  return (
    <span className="text-[18px] leading-none font-extrabold tracking-[-0.035em] [font-stretch:110%]">
      <span className="text-navy">agent</span>
      <span className="text-cyan">wallet</span>
    </span>
  );
}

function Frame({ children, live }: { children: React.ReactNode; live?: boolean }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col px-4 pb-[max(16px,env(safe-area-inset-bottom))]">
      <header className="flex h-14 items-center justify-between">
        <Wordmark />
        <span className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-micro font-semibold ${live ? "bg-sky text-cyan-ink" : "bg-amber-soft text-amber"}`}>
          {live ? "Base Sepolia · test" : "Test mode"}
        </span>
      </header>
      {children}
      <a href={WEB_URL} className="mt-6 text-center text-label font-semibold text-cyan-ink">
        Back to agent wallet
      </a>
    </div>
  );
}

function Invalid({ title, text }: { title: string; text: string }) {
  return (
    <Frame>
      <div className="rise mt-16 rounded-2xl bg-white p-6 text-center shadow-sm">
        <TriangleAlert className="mx-auto size-8 text-amber" />
        <h1 className="mt-3 text-head font-semibold">{title}</h1>
        <p className="mt-1 text-body text-mute">{text}</p>
      </div>
    </Frame>
  );
}

function WebViewNotice() {
  const app = inAppBrowser();
  if (!app) return null;
  return (
    <div className="mb-3 rounded-xl bg-amber-soft p-3 text-label text-amber">
      Passkeys don't work inside {app}. Open this page in Safari or Chrome: tap the menu, then "Open in browser".
    </div>
  );
}

export function App() {
  const r = route();
  if (!r) return <Invalid title="This link isn't valid" text="Ask your assistant for a new one." />;
  return r.kind === "enrol" ? <Enrol token={r.token} /> : <Approve token={r.token} />;
}

function Enrol({ token }: { token: string }) {
  const info = useQuery(api.vault.enrolInfo, { token });
  const complete = useMutation(api.vault.completeEnrol);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();
  if (info === undefined && !done) return <Frame><div className="mt-4 h-80 animate-pulse rounded-2xl bg-white" /></Frame>;
  if (done) {
    return (
      <Frame live>
        <div className="mt-14 flex flex-col items-center text-center">
          <span className="pop grid size-20 place-items-center rounded-full bg-green text-white">
            <Check className="size-10" strokeWidth={3} />
          </span>
          <h1 className="rise mt-6 text-head font-semibold">Passkey saved</h1>
          <p className="rise mt-1 max-w-xs text-body text-ink-2">Your wallet is being created on Base Sepolia. Go back to the app; it takes about a minute.</p>
        </div>
      </Frame>
    );
  }
  if (!info) return <Invalid title="This setup link expired" text="Start again from the Wallet screen in the app." />;
  return (
    <Frame live>
      <main className="rise mt-2 rounded-2xl bg-white p-5 shadow-[0_2px_12px_rgba(0,41,112,0.06)]">
        <span className="grid size-14 place-items-center rounded-2xl bg-sky text-navy">
          <Fingerprint className="size-7" />
        </span>
        <h1 className="mt-4 text-[24px] leading-[30px] font-bold text-navy">Create your payment passkey</h1>
        <p className="mt-2 text-body text-ink-2">
          It's the only thing that can approve payments above your limits or change them. It stays on your device; nobody else, including us, can use it.
        </p>
        <dl className="mt-4 divide-y divide-line rounded-xl bg-page px-4 text-body">
          <Detail label="Agents, per 24 hours">{formatMoney(info.dailyCeilingMinor, "USDC")}</Detail>
          <Detail label="Biggest single payment">{formatMoney(info.perPaymentMinor, "USDC")}</Detail>
          <Detail label="Always protected">{formatMoney(info.protectedMinor, "USDC")}</Detail>
        </dl>
        <div className="mt-4">
          <WebViewNotice />
          {!passkeysSupported() && <p className="mb-3 text-label text-red">This browser doesn't support passkeys.</p>}
          {error && <p className="mb-3 text-label font-medium text-red">{error}</p>}
          <button
            disabled={busy || !passkeysSupported()}
            onClick={async () => {
              setBusy(true);
              setError(undefined);
              try {
                const key = await createPasskey({ userHandle: info.userHandle, name: info.name });
                await complete({ token, ...key });
                setDone(true);
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
            className="press flex h-12 w-full items-center justify-center gap-2 rounded-[10px] bg-navy text-title font-semibold text-white disabled:opacity-60"
          >
            {busy ? <LoaderCircle className="size-5 animate-spin" /> : <Fingerprint className="size-5" />}
            Create passkey
          </button>
        </div>
      </main>
      <p className="mt-4 flex items-center justify-center gap-1.5 text-label text-mute">
        <Lock className="size-3.5" /> Uses Face ID, fingerprint or your device PIN
      </p>
    </Frame>
  );
}

function Approve({ token }: { token: string }) {
  const data = useQuery(api.approvals.get, { token });
  const decide = useMutation(api.approvals.decide);
  const submit = useMutation(api.approvals.submit);
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // Rendered from the exact bytes that will be signed, never from server-written text.
  const signed = useMemo(() => {
    if (!data?.onchain) return null;
    const a = data.onchain.action;
    const action = { op: a.op as Op, data: a.data as Hex, nonce: BigInt(a.nonce), deadline: BigInt(a.deadline) };
    return { action, view: describe(a.op as Op, a.data as Hex, data.onchain.names), digest: actionDigest(action, data.onchain.vault as Address, data.onchain.chainId) };
  }, [data?.onchain]);

  if (data === null) return <Invalid title="This link isn't valid" text="Ask your assistant for a new one." />;
  if (data === undefined) return <Frame><div className="mt-4 h-[420px] animate-pulse rounded-2xl bg-white" /></Frame>;

  const live = Boolean(data.onchain);
  const currency = data.currency as Currency;
  const deadline = data.onchain ? data.onchain.action.deadline * 1000 : data.expiresAt;
  const expired = deadline !== undefined && deadline <= now;
  const secs = deadline ? Math.max(0, Math.round((deadline - now) / 1000)) : null;
  const left = secs === null ? null : secs >= 3600 ? `${Math.floor(secs / 3600)} hr ${Math.floor((secs % 3600) / 60)} min` : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  const open = data.state === "awaiting_approval" && !expired;
  const txUrl = data.txHash ? `${data.explorer}/tx/${data.txHash}` : null;

  const approve = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (signed && data.onchain) {
        const auth = await signWithPasskey(signed.digest, data.onchain.credentialId, data.onchain.rpId);
        await submit({
          token,
          auth: { ...auth, challengeIndex: Number(auth.challengeIndex), typeIndex: Number(auth.typeIndex) },
        });
      } else {
        await decide({ token, approve: true });
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (data.state === "confirmed") {
    return (
      <Frame live={live}>
        <div className="mt-14 flex flex-col items-center text-center">
          <span className="pop grid size-20 place-items-center rounded-full bg-green text-white">
            <Check className="size-10" strokeWidth={3} />
          </span>
          {data.amountMinor > 0 ? (
            <>
              <div className="figure rise mt-6 text-[40px] leading-[44px]">{formatMoney(data.amountMinor, currency, { cents: currency === "USDC" })}</div>
              <p className="rise mt-1 text-title text-ink-2">Paid to {data.payee?.name ?? data.title}</p>
            </>
          ) : (
            <h1 className="rise mt-6 text-head font-semibold">{data.title}: done</h1>
          )}
          {txUrl ? (
            <a href={txUrl} target="_blank" rel="noopener" className="rise mt-4 inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-label font-semibold text-navy shadow-sm">
              View transaction <ExternalLink className="size-3.5" />
            </a>
          ) : (
            <p className="rise mt-3 text-label text-mute">Simulated payment. No real money moved.</p>
          )}
        </div>
      </Frame>
    );
  }

  return (
    <Frame live={live}>
      <main className="rise mt-2 overflow-hidden rounded-2xl bg-white shadow-[0_2px_12px_rgba(0,41,112,0.06)]">
        <div className="px-5 pt-6 pb-5 text-center">
          <div className="text-body text-ink-2">{data.agent ? `${data.agent} wants to` : "You're about to"}</div>
          {data.amountMinor > 0 ? (
            <div className="figure mt-1 text-[44px] leading-[48px] text-navy">{formatMoney(data.amountMinor, currency, { cents: currency === "USDC" })}</div>
          ) : (
            <div className="mt-1 text-[24px] leading-[30px] font-bold text-navy">{signed?.view.title ?? data.title}</div>
          )}
          {data.payee && (
            <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-page py-1.5 pr-3 pl-1.5">
              <span className="grid size-7 place-items-center rounded-full bg-navy text-label font-bold text-white">{data.payee.name.slice(0, 1)}</span>
              <span className="text-body font-semibold">{data.payee.name}</span>
              {data.payee.trusted && <ShieldCheck className="size-4 text-green" aria-label="In your contacts" />}
            </div>
          )}
        </div>

        {signed ? (
          <div className="border-t border-line px-5 py-3">
            <div className="mb-1 flex items-center gap-1.5 text-micro font-semibold text-green uppercase">
              <ShieldCheck className="size-3.5" /> Your passkey signs exactly this
            </div>
            <dl className="divide-y divide-line text-body">
              {signed.view.lines.map((l, i) =>
                l.label ? (
                  <Detail key={i} label={l.label}>
                    <span className={l.mono ? "num text-label break-all" : ""}>{l.value}</span>
                  </Detail>
                ) : (
                  <div key={i} className="pt-3 pb-1 text-label font-semibold text-ink">{l.value}</div>
                ),
              )}
              <Detail label="Vault">
                <span className="num text-label break-all">{data.onchain!.vault}</span>
              </Detail>
            </dl>
          </div>
        ) : (
          <dl className="divide-y divide-line border-t border-line px-5 text-body">
            <Detail label="From">
              {data.rail === "handoff" ? (
                <span className="flex items-center gap-1.5"><Landmark className="size-4 text-mute" /> Bank account via UPI</span>
              ) : (
                <span className="flex items-center gap-1.5"><Wallet className="size-4 text-mute" /> Agent wallet</span>
              )}
            </Detail>
          </dl>
        )}

        <dl className="divide-y divide-line border-t border-line px-5 text-body">
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
          {open && live && <WebViewNotice />}
          {error && <p className="mb-3 text-label font-medium text-red">{error}</p>}
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
                onClick={() => decide({ token, approve: false })}
                className="press flex h-12 items-center justify-center gap-1.5 rounded-[10px] border border-line text-title font-semibold text-ink-2 disabled:opacity-50"
              >
                <X className="size-4" /> Decline
              </button>
              <button
                disabled={busy || (live && !passkeysSupported())}
                onClick={approve}
                className="press flex h-12 items-center justify-center gap-2 rounded-[10px] bg-navy text-title font-semibold text-white disabled:opacity-60"
              >
                {busy ? <LoaderCircle className="size-5 animate-spin" /> : live ? <Fingerprint className="size-5" /> : <Check className="size-5" strokeWidth={2.5} />}
                {live ? "Approve with passkey" : "Approve"}
              </button>
            </div>
          ) : data.state === "reserved" || data.state === "submitted" ? (
            <div className="flex h-12 items-center justify-center gap-2 rounded-[10px] bg-sky text-title font-semibold text-navy">
              <LoaderCircle className="size-5 animate-spin" /> {data.state === "reserved" ? "Sending to the network" : "Waiting for confirmation"}
            </div>
          ) : (
            <div className="flex h-12 items-center justify-center rounded-[10px] bg-page px-3 text-center text-body font-semibold text-ink-2">
              {expired || data.state === "expired" ? "This request expired" : data.state === "cancelled" ? "Declined" : data.state === "failed" ? data.reason ?? "Failed" : "Already handled"}
            </div>
          )}
          {txUrl && (
            <a href={txUrl} target="_blank" rel="noopener" className="mt-3 flex items-center justify-center gap-1.5 text-label font-semibold text-cyan-ink">
              View transaction <ExternalLink className="size-3.5" />
            </a>
          )}
        </div>
      </main>
      <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-label text-mute">
        <Lock className="size-3.5 shrink-0" />
        {live ? "Checked by the wallet contract itself. Changing any detail breaks the signature." : "Test mode. This payment isn't on-chain."}
      </p>
    </Frame>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <dt className="shrink-0 text-mute">{label}</dt>
      <dd className="min-w-0 text-right font-medium">{children}</dd>
    </div>
  );
}
