"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import {
  Activity,
  Bell,
  Bot,
  House,
  MessageCircle,
  Settings,
  Snowflake,
  Users,
  Wallet,
  ChartPie,
} from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useDemo } from "@/lib/demo";
import { Initial, Wordmark } from "./brand";
import { Button, Sheet } from "./ui";

const NAV = [
  { href: "/", label: "Home", icon: House },
  { href: "/assistant", label: "Assistant", icon: MessageCircle },
  { href: "/money", label: "Money", icon: ChartPie },
  { href: "/wallet", label: "Wallet", icon: Wallet },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/family", label: "Family", icon: Users },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/settings", label: "Settings", icon: Settings },
];

const TABS = [
  { href: "/", label: "Home", icon: House },
  { href: "/money", label: "Money", icon: ChartPie },
  { href: "/assistant", label: "Ask", icon: MessageCircle, center: true },
  { href: "/wallet", label: "Wallet", icon: Wallet },
  { href: "/agents", label: "Agents", icon: Bot },
];

function active(path: string, href: string) {
  return href === "/" ? path === "/" : path.startsWith(href);
}

export function FreezeAll({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const freeze = useMutation(api.agents.freezeAll);
  return (
    <>
      <Button tone="danger" icon={Snowflake} className={className} onClick={() => { setDone(null); setOpen(true); }}>
        Freeze all agents
      </Button>
      <Sheet open={open} onOpenChange={setOpen} title={done === null ? "Freeze every agent?" : "Agents frozen"}>
        {done === null ? (
          <>
            <p className="text-body text-ink-2">They stop spending right away. You can unfreeze each one from Agents.</p>
            <div className="mt-5 mb-2 grid grid-cols-2 gap-2">
              <Button tone="outline" size="lg" onClick={() => setOpen(false)}>Cancel</Button>
              <Button tone="danger" size="lg" icon={Snowflake} onClick={async () => setDone(await freeze())}>Freeze</Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-body text-ink-2">{done === 0 ? "Nothing was active." : `${done} ${done === 1 ? "agent" : "agents"} can't spend now.`}</p>
            <Button size="lg" className="mt-5 mb-2 w-full" onClick={() => setOpen(false)}>Done</Button>
          </>
        )}
      </Sheet>
    </>
  );
}

function Sidebar() {
  const path = usePathname();
  const me = useQuery(api.users.me);
  const { demo } = useDemo();
  return (
    <aside className="fixed top-[var(--bar,0px)] bottom-0 left-0 hidden w-[248px] flex-col border-r border-line bg-white lg:flex">
      <Link href="/" className="flex h-16 items-center px-6">
        <Wordmark />
      </Link>
      <nav className="flex-1 space-y-0.5 px-3 pt-2">
        {NAV.map(({ href, label, icon: Icon }) => {
          const on = active(path, href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex h-10 items-center gap-3 rounded-btn px-3 text-body font-medium transition-colors",
                on ? "bg-sky font-semibold text-navy" : "text-ink-2 hover:bg-page hover:text-ink",
              )}
            >
              <Icon className="size-[18px]" strokeWidth={on ? 2.2 : 1.8} />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="space-y-3 border-t border-line p-4">
        <FreezeAll className="w-full" />
        {me && (
          <Link href="/settings" className="flex items-center gap-2.5 rounded-btn p-1 hover:bg-page">
            <Initial name={me.name} size={32} />
            <div className="min-w-0">
              <div className="truncate text-body font-semibold">{me.name}</div>
              <div className="truncate text-label text-mute">{demo ? "Demo account" : me.email}</div>
            </div>
          </Link>
        )}
      </div>
    </aside>
  );
}

function TopBar() {
  const me = useQuery(api.users.me);
  const path = usePathname();
  return (
    <header className="sticky top-[var(--bar,0px)] z-30 flex h-14 items-center gap-3 border-b border-line bg-white/95 px-4 backdrop-blur lg:hidden">
      <Link href="/settings" aria-label="Settings" className="press">
        <Initial name={me?.name ?? " "} size={34} />
      </Link>
      <div className="min-w-0 flex-1">
        {path === "/" ? (
          <div className="truncate text-title font-semibold">{me ? `Hi, ${me.name}` : ""}</div>
        ) : (
          <Wordmark className="text-[18px]" />
        )}
      </div>
      <Link href="/family" aria-label="Family" className="press grid size-9 place-items-center rounded-full text-navy hover:bg-page">
        <Users className="size-5" strokeWidth={1.9} />
      </Link>
      <Link href="/activity" aria-label="Activity" className="press grid size-9 place-items-center rounded-full text-navy hover:bg-page">
        <Bell className="size-5" strokeWidth={1.9} />
      </Link>
    </header>
  );
}

function BottomTabs() {
  const path = usePathname();
  return (
    <nav className="pb-safe fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 bg-white px-2 pt-1.5 shadow-[var(--shadow-bar)] lg:hidden">
      {TABS.map(({ href, label, icon: Icon, center }) => {
        const on = active(path, href);
        if (center) {
          return (
            <Link key={href} href={href} className="press -mt-5 flex flex-col items-center gap-1">
              <span className={cn("grid size-[52px] place-items-center rounded-full border-4 border-white text-white shadow-[0_4px_12px_rgba(0,41,112,0.25)]", on ? "bg-cyan" : "bg-navy")}>
                <Icon className="size-[22px]" strokeWidth={2} />
              </span>
              <span className={cn("text-micro font-semibold", on ? "text-navy" : "text-mute")}>{label}</span>
            </Link>
          );
        }
        return (
          <Link key={href} href={href} className="press flex flex-col items-center gap-1 py-1">
            <Icon className={cn("size-[22px]", on ? "text-navy" : "text-mute")} strokeWidth={on ? 2.2 : 1.8} />
            <span className={cn("text-micro font-semibold", on ? "text-navy" : "text-mute")}>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const chat = path.startsWith("/assistant");
  return (
    <div className="min-h-dvh lg:pl-[248px]">
      <Sidebar />
      <TopBar />
      <main className={cn("mx-auto max-w-[1120px] px-4 pt-4 lg:px-8 lg:pt-8", chat ? "pb-0" : "pb-28 lg:pb-12")}>
        {children}
      </main>
      {!chat && <BottomTabs />}
    </div>
  );
}
