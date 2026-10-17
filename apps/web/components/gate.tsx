"use client";

import Link from "next/link";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, FlaskConical, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useDemo } from "@/lib/demo";
import { Character } from "@agent-wallet/brand";
import { Wordmark } from "./brand";
import { Landing } from "./landing";
import { Shell } from "./shell";
import { ButtonLink } from "./ui";

function Splash() {
  return (
    <div className="grid min-h-dvh place-items-center bg-white">
      <Character of="nudge" mood="happy" size={72} bob title="Nudge is loading" />
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
      if (!String(e.reason?.data ?? e.reason?.message ?? e.reason).includes("read-only")) return;
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
