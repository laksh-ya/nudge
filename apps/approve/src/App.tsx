import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { Check, Clock, ExternalLink, Fingerprint, Landmark, LoaderCircle, Lock, ShieldCheck, TriangleAlert, Wallet, X } from "lucide-react";
import { api } from "@agent-wallet/backend/api";
import { Character, Logo } from "@agent-wallet/brand";
import { CHAIN_ID, actionDigest, checkApproval, formatMoney, isVaultVersion, policyVaultAbi, testUsdAbi, Op, type ChainReader, type Currency, type Truth } from "@agent-wallet/domain";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { createPasskey, inAppBrowser, passkeysSupported, signWithPasskey } from "./passkey";

const WEB_URL = import.meta.env.VITE_WEB_URL ?? "https://nudge-wallet.vercel.app";

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
  async state() {
    const read = <F extends "heldTotal" | "protectedAmount" | "dailyCeiling" | "vaultSpentToday" | "frozen" | "token">(functionName: F) =>
      baseSepolia.readContract({ address: vault, abi: policyVaultAbi, functionName });
    const [token, held, protectedAmount, dailyCeiling, spent24h, frozen] = await Promise.all([
      read("token"),
      read("heldTotal"),
      read("protectedAmount"),
      read("dailyCeiling"),
      read("vaultSpentToday"),
      read("frozen"),
    ]);
    const balance = await baseSepolia.readContract({ address: token as Address, abi: testUsdAbi, functionName: "balanceOf", args: [vault] });
    return { balance, held, protectedAmount, dailyCeiling, spent24h, frozen } as Awaited<ReturnType<NonNullable<ChainReader["state"]>>>;
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
  // Refusals come as ConvexError with the sentence in `data`; production blanks other server errors.
  const data = (e as { data?: unknown } | null)?.data;
  if (typeof data === "string") return data.slice(0, 160);
  const uncaught = m.match(/Uncaught (?:Convex)?Error: ([^\n]+)/);
  if (uncaught) return uncaught[1]!.slice(0, 160);
  if (m.includes("Server Error")) return "Something went wrong on our side. Try again in a moment.";
  return m.slice(0, 160);
}

function Wordmark() {
  return <Logo size={20} />;
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
        Back to Nudge
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

/** Agents never get approval links; the owner opens them from the dashboard or Telegram. */
const STALE = "Open the latest request from your dashboard or Telegram.";

function Home() {
  return (
    <Frame live>
      <div className="rise mt-16 rounded-2xl bg-white p-6 text-center shadow-sm">
        <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-sky text-navy">
          <Fingerprint className="size-7" />
        </span>
        <h1 className="mt-4 text-head font-semibold">Nothing to approve right now</h1>
        <p className="mt-1 text-body text-ink-2">
          This site does one thing: you approve payments and rule changes for your Nudge wallet with your passkey. Requests reach you as links in the
          dashboard or Telegram.
        </p>
        <p className="mt-3 text-label text-mute">Base Sepolia testnet. Test dollars (tUSD) only, no real value.</p>
      </div>
    </Frame>
  );
}

function Loading() {
  // The shape of a request, so the page doesn't jump when it arrives.
  return (
    <Frame>
      <div className="mt-2 overflow-hidden rounded-2xl bg-white shadow-[0_2px_12px_rgba(0,41,112,0.06)]" aria-busy="true">
        <div className="flex flex-col items-center px-5 pt-6 pb-5">
          <div className="h-4 w-36 animate-pulse rounded bg-page" />
          <div className="mt-3 h-11 w-44 animate-pulse rounded-lg bg-page" />
          <div className="mt-3 h-8 w-32 animate-pulse rounded-full bg-page" />
        </div>
        <div className="space-y-3 border-t border-line px-5 py-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex justify-between gap-4">
              <div className="h-4 w-20 animate-pulse rounded bg-page" />
              <div className="h-4 w-28 animate-pulse rounded bg-page" />
            </div>
          ))}
        </div>
        <div className="border-t border-line p-4">
          <div className="h-12 animate-pulse rounded-[10px] bg-page" />
        </div>
      </div>
      <p className="mt-4 text-center text-label text-mute">Checking the request…</p>
    </Frame>
  );
}

export function App() {
  if (window.location.pathname === "/" || window.location.pathname === "") return <Home />;
  const r = route();
  if (!r) return <Invalid title="This link isn't valid" text={STALE} />;
  return r.kind === "enrol" ? <Enrol token={r.token} /> : <Approve token={r.token} />;
}

function Enrol({ token }: { token: string }) {
  const info = useQuery(api.vault.enrolInfo, { token });
  const complete = useMutation(api.vault.completeEnrol);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string>();
  const [error, setError] = useState<string>();
  if (info === undefined && !code) return <Loading />;
  if (code) {
    // The app (signed in as the owner) asks for this code. A copied setup link alone gets nowhere.
    return (
      <Frame live>
        <div className="mt-14 flex flex-col items-center text-center">
          <span className="pop relative">
            <Character of="nudge" mood="happy" size={88} />
            <span className="absolute -right-1 -bottom-1 grid size-8 place-items-center rounded-full bg-green text-white ring-4 ring-page"><Check className="size-4" strokeWidth={3} /></span>
          </span>
          <h1 className="rise mt-6 text-head font-semibold">Passkey made. One step left</h1>
          <p className="rise mt-1 max-w-xs text-body text-ink-2">Type this code in the app, on the Wallet screen, to confirm it's yours.</p>
          <div className="figure rise mt-5 rounded-2xl bg-white px-6 py-3 text-[40px] leading-[44px] tracking-[0.12em] text-navy shadow-sm">
            {code.slice(0, 3)} {code.slice(3)}
          </div>
          <p className="rise mt-3 text-label text-mute">Valid for 15 minutes. If you didn't start this, don't type it anywhere.</p>
          {/* Same device: straight back to the screen that asks for this code. On another device, open Nudge there. */}
          <a href={`${WEB_URL}/wallet`} className="press rise mt-6 flex h-12 w-full max-w-xs items-center justify-center rounded-[10px] bg-navy text-title font-semibold text-white">
            Back to Nudge to enter it
          </a>
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
  const decline = useMutation(api.approvals.decline);
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // A first payment to an address not in the vault signs only after the owner says they checked it.
  const [checked, setChecked] = useState(false);

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

  if (data === null) return <Invalid title="This link isn't valid" text={STALE} />;
  if (data === undefined) return <Loading />;

  const live = Boolean(data.onchain);
  const currency = data.currency as Currency;
  const deadline = data.onchain ? data.onchain.action.deadline * 1000 : data.expiresAt;
  const expired = deadline !== undefined && deadline <= now;
  const secs = deadline ? Math.max(0, Math.round((deadline - now) / 1000)) : null;
  const left = secs === null ? null : secs >= 3600 ? `${Math.floor(secs / 3600)} hr ${Math.floor((secs % 3600) / 60)} min` : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  const legacy = Boolean(data.onchain && !isVaultVersion(data.onchain.version));
  const open = data.state === "awaiting_approval" && !expired && !legacy;
  // Signing waits for the check, and never happens when the server and the bytes disagree.
  const unchecked = Boolean(truth?.payee?.fresh) && !checked;
  const blocked = live && (!truth || truth.mismatches.length > 0 || unchecked);
  const txUrl = data.txHash ? `${data.explorer}/tx/${data.txHash}` : null;
  // A payment if the signed bytes say so (on-chain), or the request carries an amount (test mode).
  const payment = live ? data.onchain!.action.op === Op.Pay || truth?.amountMinor != null : data.amountMinor > 0;

  const reject = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await decline({ token });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

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
    const wait = waitLabel(data.onchain?.changeDelay ?? 0);
    const paying = data.amountMinor > 0;
    return (
      <Frame live>
        <div className="mt-14 flex flex-col items-center text-center">
          <span className="pop"><Character of="nudge" mood="watch" size={88} /></span>
          <h1 className="rise mt-6 text-head font-semibold">
            Approved. {paying ? "Pays" : "Applies"} at {clock(data.readyAt)}
          </h1>
          <p className="rise mt-1 max-w-xs text-body text-ink-2">
            {paying
              ? `Paying someone who isn't saved in your vault waits ${wait} (your vault's change delay), so a payment you didn't mean can still be stopped. Cancel it from the Wallet screen until then.`
              : `Loosening a rule waits ${wait} (your vault's change delay). You can cancel it from the Wallet screen until then.`}
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

  if (data.state === "cancelled") {
    return (
      <Frame live={live}>
        <div className="mt-14 flex flex-col items-center text-center">
          <span className="pop"><Character of="nudge" mood="sleep" size={88} /></span>
          {data.reason?.startsWith("Handled through another link") ? (
            <>
              <h1 className="rise mt-6 text-head font-semibold">Already handled</h1>
              <p className="rise mt-1 max-w-xs text-body text-ink-2">You decided this request through another link. This one is closed.</p>
            </>
          ) : (
            <>
              <h1 className="rise mt-6 text-head font-semibold">Declined</h1>
              <p className="rise mt-1 max-w-xs text-body text-ink-2">{payment ? "Nothing was paid." : "Nothing was changed."} The request is closed.</p>
            </>
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
          {data.amountMinor > 0 && data.payee && !data.payee.trusted && (
            // A separate, optional choice (#98): paying once never made them trusted.
            <div className="rise mt-6 w-full max-w-xs rounded-2xl bg-white p-4 text-left shadow-sm">
              <div className="text-body font-semibold">Pay {data.payee.name} again without asking?</div>
              <p className="mt-1 text-label text-ink-2">
                Only if you want: add them as a trusted contact and your assistants can pay them on their own, within their limits. It takes your
                passkey once, then your vault's wait for new contacts.
              </p>
              <a href={`${WEB_URL}/wallet`} className="press mt-3 flex h-10 items-center justify-center rounded-[10px] bg-sky text-body font-semibold text-navy">
                Add as trusted contact
              </a>
            </div>
          )}
        </div>
      </Frame>
    );
  }

  return (
    <Frame live={live}>
      <main className="rise mt-2 overflow-hidden rounded-2xl bg-white shadow-[0_2px_12px_rgba(0,41,112,0.06)]">
        <div className="px-5 pt-6 pb-5 text-center">
          <div className="mb-3 flex items-end justify-center gap-2">
            {data.agentProvider && data.agentProvider !== "own" && <Character of={data.agentProvider} mood="watch" size={48} />}
            <Character of="nudge" mood={open ? "wink" : "neutral"} size={open ? 60 : 48} bob={open} />
          </div>
          <div className="text-body text-ink-2">{headline(data.agent, payment)}</div>
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
                  ) : truth.payee.fresh ? (
                    // Someone new. Still red with the whole address: this is also how a swapped payee looks.
                    <div className="mt-3 flex flex-col items-center gap-1.5">
                      <div className="inline-flex items-center gap-2 rounded-full bg-red-soft py-1.5 pr-3 pl-2 text-red">
                        <TriangleAlert className="size-4" />
                        <span className="text-body font-semibold">Not a saved contact</span>
                      </div>
                      <span className="num max-w-[30ch] text-label break-all text-ink">{truth.payee.address}</span>
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
                <span className="flex items-center gap-1.5"><Wallet className="size-4 text-mute" /> Nudge wallet</span>
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
          {open && live && truth?.payee?.fresh && truth.mismatches.length === 0 && (
            <label className="mb-3 flex items-start gap-2.5 rounded-xl border border-red/30 bg-red-soft p-3 text-label text-ink">
              <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[#c62828]" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
              <span>
                <span className="font-semibold text-red">First payment to this address.</span> I checked the full address above with who I'm paying
                {truth.payee.label ? ` (${truth.payee.label})` : ""}. Pay it once; this doesn't make them a trusted contact, and your vault waits{" "}
                {waitLabel(data.onchain?.changeDelay ?? 0)} before the money leaves, so I can still cancel.
              </span>
            </label>
          )}
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
            // Declining only stops the request, so the link may do that.
            <div className="grid grid-cols-[1fr_2fr] gap-2">
              <button
                disabled={busy}
                onClick={reject}
                className="press flex h-12 items-center justify-center gap-1.5 rounded-[10px] border border-line text-title font-semibold text-ink-2 disabled:opacity-60"
              >
                <X className="size-4" /> Decline
              </button>
              <a
                href={WEB_URL}
                className="press flex h-12 items-center justify-center gap-2 rounded-[10px] bg-navy text-title font-semibold text-white"
              >
                <Check className="size-5" strokeWidth={2.5} /> Approve in the app
              </a>
            </div>
          ) : open ? (
            <div className="grid grid-cols-[1fr_2fr] gap-2">
              <button
                disabled={busy}
                onClick={reject}
                className="press flex h-12 items-center justify-center gap-1.5 rounded-[10px] border border-line text-title font-semibold text-ink-2 disabled:opacity-60"
              >
                <X className="size-4" /> Decline
              </button>
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
              {expired || data.state === "expired" ? "This request expired" : data.state === "failed" ? data.reason ?? "Failed" : "Already handled"}
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
        {live
          ? "Checked by the wallet contract itself. Changing any detail breaks the signature. Test dollars (tUSD), no real value."
          : "Test mode. This payment isn't on-chain."}
      </p>
    </Frame>
  );
}

function waitLabel(seconds: number) {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 86_400) return `${+(seconds / 3600).toFixed(1)} h`;
  return seconds === 86_400 ? "1 day" : `${+(seconds / 86_400).toFixed(1)} days`;
}

function headline(agent: string | undefined, payment: boolean) {
  if (!payment) return "You're about to approve";
  return agent ? `${agent} wants to pay` : "You're about to pay";
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <dt className="shrink-0 text-mute">{label}</dt>
      <dd className="min-w-0 text-right font-medium">{children}</dd>
    </div>
  );
}
