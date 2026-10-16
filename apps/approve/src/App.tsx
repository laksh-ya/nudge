import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { Check, Clock, ExternalLink, Fingerprint, Landmark, LoaderCircle, Lock, ShieldCheck, TriangleAlert, Wallet, X } from "lucide-react";
import { api } from "@agent-wallet/backend/api";
import { CHAIN_ID, actionDigest, checkApproval, formatMoney, isVaultVersion, policyVaultAbi, type ChainReader, type Currency, type Op, type Truth } from "@agent-wallet/domain";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { createPasskey, inAppBrowser, passkeysSupported, signWithPasskey } from "./passkey";

const WEB_URL = import.meta.env.VITE_WEB_URL ?? "http://localhost:3000";

/** Reads the vault from a public Base Sepolia node, so what the page calls a saved contact doesn't depend on our server. */
const baseSepolia = createPublicClient({
  chain: { id: CHAIN_ID, name: "Base Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://sepolia.base.org"] } } },
  transport: http("https://sepolia.base.org"),
});
const vaultReader = (vault: Address): ChainReader => ({
  async contact(contactId) {
    const [payee, activeAt] = await baseSepolia.readContract({ address: vault, abi: policyVaultAbi, functionName: "contacts", args: [contactId] });
    return { payee, activeAt: BigInt(activeAt) };
  },
});

function route(): { kind: "approve" | "enrol"; token: string } | null {
  const m = window.location.pathname.match(/^\/(a|enrol)\/([A-Za-z0-9]+)$/);
  if (!m) return null;
  return { kind: m[1] === "a" ? "approve" : "enrol", token: m[2]! };
}

/** Server time, so a phone whose clock is off doesn't show a live request as expired. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  const [skew, setSkew] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    const sent = Date.now();
    fetch(window.location.origin, { method: "HEAD", cache: "no-store" })
      .then((r) => {
        const server = Date.parse(r.headers.get("date") ?? "");
        const local = (sent + Date.now()) / 2;
        if (Number.isFinite(server) && Math.abs(server - local) > 5000) setSkew(server - local);
      })
      .catch(() => {});
    return () => clearInterval(id);
  }, []);
  return now + skew;
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
  const [code, setCode] = useState<string>();
  const [error, setError] = useState<string>();
  if (info === undefined && !code) return <Frame><div className="mt-4 h-80 animate-pulse rounded-2xl bg-white" /></Frame>;
  if (code) {
    // The app (signed in as the owner) asks for this code. A copied setup link alone gets nowhere.
    return (
      <Frame live>
        <div className="mt-14 flex flex-col items-center text-center">
          <span className="pop grid size-20 place-items-center rounded-full bg-green text-white">
            <Check className="size-10" strokeWidth={3} />
          </span>
          <h1 className="rise mt-6 text-head font-semibold">Passkey made. One step left</h1>
          <p className="rise mt-1 max-w-xs text-body text-ink-2">Type this code in the app, on the Wallet screen, to confirm it's yours.</p>
          <div className="figure rise mt-5 rounded-2xl bg-white px-6 py-3 text-[40px] leading-[44px] tracking-[0.12em] text-navy shadow-sm">
            {code.slice(0, 3)} {code.slice(3)}
          </div>
          <p className="rise mt-3 text-label text-mute">Valid for 15 minutes. If you didn't start this, don't type it anywhere.</p>
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
        <h1 className="mt-4 text-[24px] leading-[30px] font-bold text-navy">{info.purpose === "backup" ? "Add a backup passkey" : "Create your payment passkey"}</h1>
        <p className="mt-2 text-body text-ink-2">
          {info.purpose === "backup"
            ? "Make it on a different device. If you lose your phone, this one can still approve payments and changes."
            : "It's what approves payments above your limits and any change to them, with your device's own check: Face ID, fingerprint or PIN."}
        </p>
        {info.purpose === "first" && (
          <dl className="mt-4 divide-y divide-line rounded-xl bg-page px-4 text-body">
            <Detail label="Agents, per 24 hours">{formatMoney(info.dailyCeilingMinor, "USDC")}</Detail>
            <Detail label="Biggest single payment">{formatMoney(info.perPaymentMinor, "USDC")}</Detail>
            <Detail label="Protected from agents">{formatMoney(info.protectedMinor, "USDC")}</Detail>
          </dl>
        )}
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
                const key = await createPasskey({ userHandle: info.userHandle, name: info.name, challenge: info.challenge, backup: info.purpose === "backup" });
                setCode(await complete({ token, ...key }));
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

function clock(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function Approve({ token }: { token: string }) {
  const data = useQuery(api.approvals.get, { token });
  const submit = useMutation(api.approvals.submit);
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // The digest is computed here from the exact bytes; the server never supplies the challenge.
  const signed = useMemo(() => {
    if (!data?.onchain) return null;
    const a = data.onchain.action;
    const action = { op: a.op as Op, data: a.data as Hex, nonce: BigInt(a.nonce), deadline: BigInt(a.deadline) };
    return { action, digest: actionDigest(action, data.onchain.vault as Address, data.onchain.chainId) };
  }, [data?.onchain]);

  // What the page shows comes from those bytes and the vault's own records; server fields are only compared.
  const [truth, setTruth] = useState<Truth | null>(null);
  const onchain = data?.onchain;
  const claimedAmount = data?.amountMinor;
  const claimedPayee = data?.payee;
  useEffect(() => {
    if (!onchain) return;
    let live = true;
    void checkApproval(
      onchain.action.op as Op,
      onchain.action.data as Hex,
      {
        amountMinor: claimedAmount || undefined,
        payee: claimedPayee ? { name: claimedPayee.name, address: claimedPayee.address } : null,
        contacts: onchain.contacts,
        names: onchain.names,
      },
      vaultReader(onchain.vault as Address),
    ).then((t) => live && setTruth(t));
    return () => {
      live = false;
    };
  }, [onchain, claimedAmount, claimedPayee]);

  if (data === null) return <Invalid title="This link isn't valid" text="Ask your assistant for a new one." />;
  if (data === undefined) return <Frame><div className="mt-4 h-[420px] animate-pulse rounded-2xl bg-white" /></Frame>;

  const live = Boolean(data.onchain);
  const currency = data.currency as Currency;
  const deadline = data.onchain ? data.onchain.action.deadline * 1000 : data.expiresAt;
  const expired = deadline !== undefined && deadline <= now;
  const secs = deadline ? Math.max(0, Math.round((deadline - now) / 1000)) : null;
  const left = secs === null ? null : secs >= 3600 ? `${Math.floor(secs / 3600)} hr ${Math.floor((secs % 3600) / 60)} min` : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  const legacy = Boolean(data.onchain && !isVaultVersion(data.onchain.version));
  const open = data.state === "awaiting_approval" && !expired && !legacy;
  // Signing waits for the check, and never happens when the server and the bytes disagree.
  const blocked = live && (!truth || truth.mismatches.length > 0);
  const txUrl = data.txHash ? `${data.explorer}/tx/${data.txHash}` : null;

  const approve = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (signed && data.onchain) {
        const ids = data.onchain.credentialIds.length ? data.onchain.credentialIds : data.onchain.credentialId ? [data.onchain.credentialId] : [];
        const { auth, credentialId } = await signWithPasskey(signed.digest, ids, data.onchain.rpId);
        const result = await submit({
          token,
          credentialId,
          auth: { ...auth, challengeIndex: Number(auth.challengeIndex), typeIndex: Number(auth.typeIndex) },
        });
        if (result === "rejected") setError("That signature doesn't match this request. Nothing was sent; you can try again.");
        if (result === "too_many_attempts") setError("Too many failed signatures. Wait 15 minutes, or decline this request in the app.");
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (data.state === "queued" && data.readyAt) {
    return (
      <Frame live>
        <div className="mt-14 flex flex-col items-center text-center">
          <span className="pop grid size-20 place-items-center rounded-full bg-amber text-white">
            <Clock className="size-10" strokeWidth={2.5} />
          </span>
          <h1 className="rise mt-6 text-head font-semibold">Approved. Applies at {clock(data.readyAt)}</h1>
          <p className="rise mt-1 max-w-xs text-body text-ink-2">
            Loosening a rule waits {Math.round((data.onchain?.changeDelay ?? 0) / 60)} min in the vault. You can cancel it from the Wallet screen until then.
          </p>
          {txUrl && (
            <a href={txUrl} target="_blank" rel="noopener" className="rise mt-4 inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-label font-semibold text-navy shadow-sm">
              View transaction <ExternalLink className="size-3.5" />
            </a>
          )}
        </div>
      </Frame>
    );
  }

  if (data.state === "reported") {
    return (
      <Frame live={live}>
        <div className="mt-14 flex flex-col items-center text-center">
          <span className="grid size-20 place-items-center rounded-full bg-line text-ink-2">
            <Landmark className="size-9" strokeWidth={2} />
          </span>
          <div className="figure rise mt-6 text-[40px] leading-[44px]">{formatMoney(data.amountMinor, currency)}</div>
          <p className="rise mt-1 text-title text-ink-2">You marked this paid to {data.payee?.name ?? data.title}</p>
          <p className="rise mt-3 max-w-[30ch] text-label text-mute">Your bank hasn't confirmed it. It will match when your statement arrives.</p>
        </div>
      </Frame>
    );
  }

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
          {live ? (
            // On-chain: amount and payee come only from the signed bytes and the vault.
            truth ? (
              <>
                {truth.amountMinor !== null ? (
                  <div className="figure mt-1 text-[44px] leading-[48px] text-navy">{formatMoney(truth.amountMinor, "USDC", { cents: true })}</div>
                ) : (
                  <div className="mt-1 text-[24px] leading-[30px] font-bold text-navy">{truth.title}</div>
                )}
                {truth.payee &&
                  (truth.payee.saved ? (
                    <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-page py-1.5 pr-3 pl-1.5">
                      <span className="grid size-7 place-items-center rounded-full bg-navy text-label font-bold text-white">{truth.payee.saved.name.slice(0, 1)}</span>
                      <span className="text-body font-semibold">{truth.payee.saved.name}</span>
                      <ShieldCheck className="size-4 text-green" aria-label="Saved contact in your vault" />
                    </div>
                  ) : (
                    <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-red-soft py-1.5 pr-3 pl-2 text-red">
                      <TriangleAlert className="size-4" />
                      <span className="text-body font-semibold">Not a saved contact</span>
                      <span className="num text-label">{truth.payee.address.slice(0, 6)}…{truth.payee.address.slice(-4)}</span>
                    </div>
                  ))}
              </>
            ) : (
              <div className="mx-auto mt-2 h-12 w-40 animate-pulse rounded-lg bg-page" aria-label="Checking the vault" />
            )
          ) : (
            <>
              {data.amountMinor > 0 ? (
                <div className="figure mt-1 text-[44px] leading-[48px] text-navy">{formatMoney(data.amountMinor, currency, { cents: currency === "USDC" })}</div>
              ) : (
                <div className="mt-1 text-[24px] leading-[30px] font-bold text-navy">{data.title}</div>
              )}
              {data.payee && (
                <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-page py-1.5 pr-3 pl-1.5">
                  <span className="grid size-7 place-items-center rounded-full bg-navy text-label font-bold text-white">{data.payee.name.slice(0, 1)}</span>
                  <span className="text-body font-semibold">{data.payee.name}</span>
                </div>
              )}
            </>
          )}
        </div>

        {truth && truth.mismatches.length > 0 && (
          <div className="border-t border-red/30 bg-red-soft px-5 py-3 text-label text-red" role="alert">
            <div className="flex items-center gap-1.5 font-semibold">
              <TriangleAlert className="size-4" /> Don't approve: the app and the signature disagree
            </div>
            <ul className="mt-1 list-disc pl-5">
              {truth.mismatches.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        )}

        {signed ? (
          <div className="border-t border-line px-5 py-3">
            <div className="mb-1 flex items-center gap-1.5 text-micro font-semibold text-green uppercase">
              <ShieldCheck className="size-3.5" /> Your passkey signs exactly this
            </div>
            <dl className="divide-y divide-line text-body">
              {(truth?.lines ?? []).map((l, i) =>
                l.label ? (
                  <Detail key={i} label={l.label}>
                    <span className={`${l.mono ? "num text-label break-all" : ""} ${l.tone === "bad" ? "font-semibold text-red" : l.tone === "ok" ? "text-green" : ""}`}>{l.value}</span>
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
          {data.reason && <Detail label="Why you're asked">{data.reason}</Detail>}
          {left && (
            <Detail label="Expires">
              <span className={`num flex items-center gap-1.5 ${expired ? "text-red" : ""}`}>
                <Clock className="size-4 text-mute" /> {expired ? "Expired" : left}
              </span>
            </Detail>
          )}
        </dl>

        {data.purpose && (
          // The assistant wrote this; nothing checks it. It sits outside what the passkey signs.
          <div className="border-t border-line bg-page px-5 py-3">
            <div className="text-micro font-semibold text-mute uppercase">Note from {data.agent ?? "the request"} · not verified</div>
            <p className="mt-1 line-clamp-3 text-body break-words text-ink-2">{data.purpose}</p>
          </div>
        )}

        <div className="border-t border-line p-4">
          {legacy && <p className="mb-3 text-label font-medium text-amber">This request was made for your earlier vault. Ask again from the app.</p>}
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
          {open && !live ? (
            // No passkey step on this rail, so this link alone must not approve: the signed-in app does.
            <a
              href={WEB_URL}
              className="press flex h-12 items-center justify-center gap-2 rounded-[10px] bg-navy text-title font-semibold text-white"
            >
              <Check className="size-5" strokeWidth={2.5} /> Approve or decline in the app
            </a>
          ) : open ? (
            <div className="grid grid-cols-[1fr_2fr] gap-2">
              <a
                href={WEB_URL}
                className="press flex h-12 items-center justify-center gap-1.5 rounded-[10px] border border-line text-title font-semibold text-ink-2"
              >
                <X className="size-4" /> Decline
              </a>
              <button
                disabled={busy || blocked || !passkeysSupported()}
                onClick={approve}
                className="press flex h-12 items-center justify-center gap-2 rounded-[10px] bg-navy text-title font-semibold text-white disabled:opacity-60"
              >
                {busy ? <LoaderCircle className="size-5 animate-spin" /> : <Fingerprint className="size-5" />}
                Approve with passkey
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
