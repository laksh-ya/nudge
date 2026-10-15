"use client";

import Link from "next/link";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
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

function DemoBar() {
  const { setDemo } = useDemo();
  return (
    <div className="sticky top-0 z-40 flex h-9 items-center justify-center gap-3 bg-navy px-4 text-label text-white lg:pl-[248px]">
      <span>You're in the demo account</span>
      <Link href="/sign-up" className="font-semibold text-cyan">Create yours</Link>
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
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <ButtonLink href="/sign-up" className="h-12 px-6 text-title">Create account</ButtonLink>
            <button
              onClick={() => setDemo(true)}
              className="press inline-flex h-12 items-center justify-center gap-2 rounded-btn bg-sky px-6 text-title font-semibold text-navy"
            >
              Try the demo <ArrowRight className="size-4" strokeWidth={2.4} />
            </button>
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
    </div>
  );
}

export function Gate({ children }: { children: React.ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { loaded } = useDemo();
  const ensure = useMutation(api.users.ensure);
  const me = useQuery(api.users.me);
  const router = useRouter();

  useEffect(() => {
    if (isAuthenticated) void ensure();
  }, [isAuthenticated, ensure]);

  useEffect(() => {
    if (me && !me.onboarded) router.replace("/onboarding");
  }, [me, router]);

  if (isLoading || !loaded) return <Splash />;
  if (!isAuthenticated) return <Landing />;
  if (me === undefined || me === null) return <Splash />;
  if (me.demo)
    return (
      <div style={{ "--bar": "36px" } as React.CSSProperties}>
        <DemoBar />
        <Shell>{children}</Shell>
      </div>
    );
  return <Shell>{children}</Shell>;
}
