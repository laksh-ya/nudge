"use client";

import Link from "next/link";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, FlaskConical, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useDemo } from "@/lib/demo";
import { Wordmark } from "./brand";
import { Shell } from "./shell";
import { ButtonLink } from "./ui";

function Splash() {
  return (
    <div className="grid min-h-dvh place-items-center bg-white">
      <Wordmark className="animate-pulse text-[28px]" />
    </div>
  );
}

function DemoBar({ readOnly }: { readOnly: boolean }) {
  const { setDemo } = useDemo();
  // Any change on the read-only account is refused by the server; say so here, whichever screen tried.
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    if (!readOnly) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onRejection = (e: PromiseRejectionEvent) => {
      if (!String(e.reason?.message ?? e.reason).includes("read-only")) return;
      e.preventDefault();
      setRefused(true);
      clearTimeout(timer);
      timer = setTimeout(() => setRefused(false), 6000);
    };
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      clearTimeout(timer);
    };
  }, [readOnly]);
  return (
    <div className={cn("sticky top-0 z-40 flex h-9 items-center justify-center gap-3 px-4 text-label text-white lg:pl-[248px]", refused ? "bg-amber" : "bg-navy")}>
      {readOnly ? (
        <>
          <span role="status">{refused ? "Changes are off here. Open your own sandbox to try that." : "Team demo account, read-only"}</span>
          {/* A route handler, not a page: it swaps cookies, so it needs a full navigation. */}
          <a href="/sandbox" className={cn("font-semibold", refused ? "text-white underline" : "text-cyan")}>Open your own sandbox</a>
        </>
      ) : (
        <>
          <span>You're in the demo account</span>
          <Link href="/sign-up" className="font-semibold text-cyan">Create yours</Link>
        </>
      )}
      <button onClick={() => setDemo(false)} className="font-semibold text-white/70 hover:text-white">Exit</button>
    </div>
  );
}

function Landing() {
  const { setDemo } = useDemo();
  return (
    <div className="flex min-h-dvh flex-col bg-white">
      <header className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-5">
        <Wordmark />
        <Link href="/sign-in" className="text-body font-semibold text-navy">Sign in</Link>
      </header>
      <main className="mx-auto grid w-full max-w-5xl flex-1 items-center gap-10 px-5 pb-12 lg:grid-cols-[1fr_400px]">
        <div className="rise">
          <h1 className="max-w-[14ch] text-[36px] leading-[40px] font-bold tracking-[-0.03em] text-navy [font-stretch:108%] lg:text-[52px] lg:leading-[56px]">
            Let your assistants pay. Only within your rules.
          </h1>
          <ul className="mt-5 max-w-[46ch] space-y-1.5 text-body text-ink-2 lg:text-title lg:font-normal">
            <li>Claude and other assistants pay your saved contacts, within limits you set.</li>
            <li>Anything bigger, and any rule you loosen, waits for your passkey.</li>
            <li>A contract on Base Sepolia enforces it, even if an assistant&apos;s key is stolen.</li>
          </ul>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <ButtonLink href="/sign-up" className="h-12 px-6 text-title">Create account</ButtonLink>
            <button
              onClick={() => setDemo(true)}
              className="press inline-flex h-12 items-center justify-center gap-2 rounded-btn bg-sky px-6 text-title font-semibold text-navy"
            >
              Try the demo <ArrowRight className="size-4" strokeWidth={2.4} />
            </button>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-label">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-soft px-2 py-1 font-semibold text-amber">
              <FlaskConical className="size-3.5" /> Base Sepolia testnet, test money only
            </span>
            <Link href="/proof" className="inline-flex items-center gap-1 font-semibold text-cyan-ink">
              See the proof on-chain <ArrowRight className="size-3.5" strokeWidth={2.4} />
            </Link>
          </div>
        </div>
        <div className="rise card overflow-hidden p-0 [animation-delay:80ms]">
          <div className="bg-navy p-5 text-white">
            <div className="text-label text-white/70">Safe to spend</div>
            <div className="figure mt-1 text-hero">₹22,907</div>
            <div className="mt-1 text-label text-white/70">₹1,272 a day · 18 days to payday</div>
          </div>
          <div className="divide-y divide-line px-5">
            {[
              ["Claude wants to pay Exa", "$18.00", "Needs you"],
              ["Your assistant paid Blue Tokai", "$8.40", "Paid"],
              ["OpenClaw tried a forwarded invoice", "$49.00", "Blocked"],
            ].map(([t, a, s]) => (
              <div key={t} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="truncate text-body font-medium">{t}</div>
                  <div className="text-label text-mute">{s}</div>
                </div>
                <div className="num text-body font-semibold">{a}</div>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 bg-sky-soft px-5 py-3 text-label text-navy">
            <ShieldCheck className="size-4" strokeWidth={2} />
            Payments over your limits wait for your passkey
          </div>
        </div>
      </main>
      <footer className="mx-auto w-full max-w-5xl px-5 pb-6 text-label text-mute">
        Testnet prototype. Wallet payments use test dollars (tUSD) with no value; bank feeds and family transfers are simulated.
      </footer>
    </div>
  );
}

/** Pages anyone may open without an account: the proof reads only the public chain. */
function PublicFrame({ children }: { children: React.ReactNode }) {
  const { setDemo } = useDemo();
  return (
    <div className="min-h-dvh bg-page">
      <header className="sticky top-0 z-30 border-b border-line bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-3 px-4">
          <Link href="/" aria-label="Home">
            <Wordmark className="text-[18px]" />
          </Link>
          <div className="flex-1" />
          <button onClick={() => setDemo(true)} className="press text-label font-semibold text-navy">
            Try the demo
          </button>
          <Link href="/sign-in" className="text-label font-semibold text-cyan-ink">
            Sign in
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-[1120px] px-4 pt-4 pb-12">{children}</main>
    </div>
  );
}

const PUBLIC = ["/proof"];

export function Gate({ children }: { children: React.ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { loaded } = useDemo();
  const ensure = useMutation(api.users.ensure);
  const me = useQuery(api.users.me);
  const router = useRouter();
  const path = usePathname();

  useEffect(() => {
    if (isAuthenticated) void ensure();
  }, [isAuthenticated, ensure]);

  useEffect(() => {
    if (me && !me.onboarded) router.replace("/onboarding");
  }, [me, router]);

  if (isLoading || !loaded) return <Splash />;
  if (!isAuthenticated) return PUBLIC.some((p) => path.startsWith(p)) ? <PublicFrame>{children}</PublicFrame> : <Landing />;
  if (me === undefined || me === null) return <Splash />;
  if (me.demo)
    return (
      <div style={{ "--bar": "36px" } as React.CSSProperties}>
        <DemoBar readOnly={me.readOnly} />
        <Shell>{children}</Shell>
      </div>
    );
  return <Shell>{children}</Shell>;
}
