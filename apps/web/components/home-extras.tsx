"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { ArrowDownLeft, ArrowUpRight, Bell, CalendarRange, MessageCircle, Plus, Receipt, Send, ShoppingBag } from "lucide-react";
import type { Currency } from "@agent-wallet/domain";
import { api } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { AgentMark } from "@/components/brand";
import { Card, Chip, Divided, IconTile, Money, Row, TextLink } from "@/components/ui";

const ACTIONS = [
  { href: "/assistant", label: "Ask Nudge", sub: "Pay, plan, remind", icon: MessageCircle, tone: "bg-navy text-white" },
  { href: "/family", label: "Send money", sub: "Family and friends", icon: Send, tone: "bg-sky text-navy" },
  { href: "/plan", label: "Plan", sub: "To payday and beyond", icon: CalendarRange, tone: "bg-sky text-navy" },
  { href: "/shop", label: "Test shop", sub: "Buy, or let an agent", icon: ShoppingBag, tone: "bg-sky text-navy" },
];

/** The four things people do most, big and plain. */
export function QuickActions() {
  return (
    <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {ACTIONS.map((a) => (
        <Link key={a.href} href={a.href} className="press card rise flex items-center gap-3 p-3 hover:shadow-[0_8px_24px_rgba(0,41,112,0.08)]">
          <span className={`grid size-10 shrink-0 place-items-center rounded-[12px] ${a.tone}`}>
            <a.icon className="size-5" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-body font-semibold">{a.label}</span>
            <span className="block truncate text-label text-mute">{a.sub}</span>
          </span>
        </Link>
      ))}
    </section>
  );
}

/** Each connected assistant at a glance: its face, what it may still spend today, and its status. */
export function AssistantsStrip() {
  const agents = useQuery(api.agents.list);
  if (!agents) return null;
  const shown = agents.filter((a) => a.status !== "revoked");
  return (
    <Card title="Your assistants" action={<TextLink href="/agents">Manage</TextLink>}>
      {shown.length <= 1 ? (
        <Link href="/agents" className="press flex items-center gap-3 rounded-[12px] border border-dashed border-line p-3 hover:border-cyan">
          <span className="grid size-10 place-items-center rounded-full bg-sky text-navy">
            <Plus className="size-5" />
          </span>
          <span>
            <span className="block text-body font-semibold">Connect Claude, Instinct or any assistant</span>
            <span className="block text-label text-mute">One setup text. It sees your money and pays within the limits you set.</span>
          </span>
        </Link>
      ) : (
        <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
          {shown.map((a) => {
            const alone = a.scopes.includes("spend") && a.perPaymentMinor > 0;
            const left = Math.max(0, a.dailyCapMinor - a.spentTodayMinor);
            return (
              <Link key={a._id} href="/agents" className="press flex w-[132px] shrink-0 flex-col items-center gap-1.5 rounded-[16px] bg-page p-3 text-center">
                <AgentMark provider={a.provider} name={a.name} size={44} mood={a.status === "frozen" ? "sleep" : a.status === "pending" ? "neutral" : "happy"} />
                <span className="w-full truncate text-label font-semibold">{a.name}</span>
                {a.status === "frozen" ? (
                  <Chip tone="red">Frozen</Chip>
                ) : a.status === "pending" ? (
                  <Chip tone="amber">Not connected</Chip>
                ) : alone ? (
                  <span className="num text-micro text-ink-2">{formatMoney(left, "USDC")} left today</span>
                ) : (
                  <span className="text-micro text-mute">Asks every time</span>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/** The next week: bills, planned income and spends, and reminders, in one list. */
export function ComingUp({ hidden }: { hidden: boolean }) {
  const p = useQuery(api.plan.projection, { days: 30 });
  const bills = useQuery(api.money.obligations);
  const reminders = useQuery(api.reminders.list);
  if (!p || !bills || !reminders) return null;
  const now = Date.now();
  const week = now + 10 * 86_400_000;
  type Item = { key: string; at: number; title: string; sub: string; amount?: { minor: number; currency: Currency }; icon: typeof Receipt; tone: "page" | "green" | "sky" };
  const items: Item[] = [
    ...bills
      .filter((b) => b.status === "active" && b.nextDueAt >= now - 86_400_000 && b.nextDueAt <= week)
      .map((b) => ({ key: b._id, at: b.nextDueAt, title: b.name, sub: b.kind === "bill" ? "Bill" : "Subscription", amount: { minor: -b.amountMinor, currency: b.currency as Currency }, icon: Receipt, tone: "page" as const })),
    ...p.events
      .filter((e) => e.kind !== "bill" && e.at <= week)
      .map((e, i) => ({ key: `p${i}`, at: e.at, title: e.name, sub: e.kind === "income" ? "Expected in" : "Planned", amount: { minor: e.amountMinor, currency: e.currency as Currency }, icon: e.kind === "income" ? ArrowDownLeft : ArrowUpRight, tone: e.kind === "income" ? ("green" as const) : ("page" as const) })),
    ...reminders.filter((r) => r.dueAt <= week).map((r) => ({ key: r._id, at: r.dueAt, title: r.text, sub: "Reminder", icon: Bell, tone: "sky" as const })),
  ].sort((a, b) => a.at - b.at);
  const day = (at: number) => {
    const d = Math.round((new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
    return d <= 0 ? "Today" : d === 1 ? "Tomorrow" : new Date(at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  };
  return (
    <Card title="Coming up" action={<TextLink href="/plan">Plan</TextLink>}>
      {items.length === 0 ? (
        <p className="text-body text-mute">
          Nothing in the next 10 days.{" "}
          <Link href="/plan" className="font-semibold text-cyan-ink">
            Add your salary or a bill
          </Link>{" "}
          to see what's ahead.
        </p>
      ) : (
        <Divided>
          {items.slice(0, 6).map((i) => (
            <Row
              key={i.key}
              leading={<IconTile icon={i.icon} tone={i.tone} />}
              title={i.title}
              sub={`${day(i.at)} · ${i.sub}`}
              trailing={i.amount ? <Money minor={i.amount.minor} currency={i.amount.currency} sign className="text-body font-semibold" hidden={hidden} /> : undefined}
            />
          ))}
        </Divided>
      )}
    </Card>
  );
}
