"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { useEffect, useState } from "react";
import {
  Activity,
  Bot,
  ChevronDown,
  Eye,
  EyeOff,
  LoaderCircle,
  MessageCircle,
  Receipt,
  Repeat,
  Target,
  TrendingUp,
  Users,
  Wallet,
  ChartPie,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { approvalLink } from "@/lib/config";
import { ago, dueLabel, formatMoney } from "@/lib/format";
import { AgentMark } from "@/components/brand";
import { ActivityIcon } from "@/components/activity-icon";
import { SetupCard } from "@/components/setup-card";
import { ButtonLink, Card, Chip, Divided, IconTile, Meter, Money, Row, Skeleton, TextLink } from "@/components/ui";

const ACTIONS = [
  { href: "/money?tab=bills", label: "Pay bills", icon: Receipt },
  { href: "/assistant", label: "Ask assistant", icon: MessageCircle },
  { href: "/family", label: "Send to family", icon: Users },
  { href: "/wallet", label: "Agent wallet", icon: Wallet },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/money", label: "Spending", icon: ChartPie },
  { href: "/money?tab=goals", label: "Goals", icon: Target },
  { href: "/activity", label: "Activity", icon: Activity },
];

function useHidden() {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    try {
      setHidden(localStorage.getItem("aw-hide") === "1");
    } catch {}
  }, []);
  const toggle = () => {
    setHidden((h) => {
      try {
        localStorage.setItem("aw-hide", h ? "0" : "1");
      } catch {}
      return !h;
    });
  };
  return [hidden, toggle] as const;
}

export default function Home() {
  const data = useQuery(api.home.overview);
  const recent = useQuery(api.activity.list);
  const [hidden, toggleHidden] = useHidden();
  const [open, setOpen] = useState(false);

  if (!data) return <HomeSkeleton />;
  const o = data.overview;
  const { attention } = data;
  const attentionCount =
    attention.approvals.length + attention.unknown.length + attention.familyRequests + attention.priceRises.length + (o.suggested > 0 ? 1 : 0);
  const maxCategory = o.categories[0]?.amount ?? 1;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-6">
      <div className="min-w-0 space-y-4 lg:space-y-6">
        <h1 className="hidden text-[24px] leading-[30px] font-semibold lg:block">Hi, {data.name}</h1>

        <section className="rise overflow-hidden rounded-card bg-navy text-white shadow-[0_8px_24px_rgba(0,41,112,0.18)]">
          <div className="p-5">
            <div className="flex items-center justify-between">
              <span className="text-label font-medium text-white/70">Safe to spend</span>
              <button
                onClick={toggleHidden}
                aria-label={hidden ? "Show amounts" : "Hide amounts"}
                className="press -m-2 grid size-9 place-items-center rounded-full text-white/80 hover:bg-white/10"
              >
                {hidden ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
              </button>
            </div>
            {o.accountCount === 0 ? (
              <>
                <div className="mt-1 text-[22px] leading-[28px] font-semibold">Add an account to see what's safe to spend</div>
                <Link href="/money?tab=accounts" className="press mt-4 inline-flex h-10 items-center rounded-btn bg-white px-4 text-body font-semibold text-navy">
                  Add accounts
                </Link>
              </>
            ) : (
            <>
            <div className="figure mt-0.5 text-hero">{hidden ? "••••••" : formatMoney(o.available, o.currency)}</div>
            <div className="mt-1 text-body text-white/75">
              <span className="num">{hidden ? "••••" : formatMoney(o.perDay, o.currency)}</span> a day ·{" "}
              {o.daysToIncome} days to payday
            </div>

            <button
              onClick={() => setOpen((v) => !v)}
              className="press mt-4 flex items-center gap-1 text-label font-semibold text-cyan"
              aria-expanded={open}
            >
              How it's worked out
              <ChevronDown className={cn("size-3.5 transition-transform duration-200", open && "rotate-180")} strokeWidth={2.5} />
            </button>
            <div className={cn("grid transition-[grid-template-rows] duration-300 ease-[var(--ease-snap)]", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
              <dl className="num space-y-2 overflow-hidden text-body">
                <div className="h-2" />
                {[
                  ["Cash in your accounts", o.cash, 1],
                  ["Card dues", o.cardDue, -1],
                  [`${o.commitmentCount} bills before payday`, o.commitments, -1],
                  ["Emergency fund", o.emergency, -1],
                  ["Pending payments", o.pending, -1],
                ].map(([label, amount, sign]) => (
                  <div key={label as string} className="flex justify-between gap-4">
                    <dt className="text-white/70">{label}</dt>
                    <dd className="font-medium">
                      {hidden ? "••••" : formatMoney((amount as number) * (sign as number), o.currency, { sign: true })}
                    </dd>
                  </div>
                ))}
                <div className="pt-1 text-label text-white/50">Account data from {ago(o.oldestSync)}</div>
              </dl>
            </div>
            </>
            )}
          </div>
          <Link href="/agents" className="press flex items-center justify-between gap-3 bg-navy-soft px-5 py-3 text-body">
            <span className="text-white/75">Agents can spend now</span>
            <span className="flex items-center gap-2 font-semibold">
              <span className="num">{formatMoney(o.agentAuthority, o.walletCurrency)}</span>
              <Chip tone="cyan" className="bg-white/10 text-cyan">Test USDC</Chip>
            </span>
          </Link>
        </section>

        <SetupCard />

        <section className="card rise grid grid-cols-4 gap-y-4 px-2 py-4">
          {ACTIONS.map(({ href, label, icon }) => (
            <Link key={label} href={href} className="press flex flex-col items-center gap-1.5 px-1 text-center">
              <IconTile icon={icon} size="lg" />
              <span className="text-label leading-[15px] font-medium text-ink">{label}</span>
            </Link>
          ))}
        </section>

        <Card title={attentionCount ? `Needs you · ${attentionCount}` : "Needs you"}>
          {attentionCount === 0 ? (
            <p className="text-body text-mute">Nothing right now.</p>
          ) : (
            <Divided>
              {attention.approvals.map((t) => (
                <Row
                  key={t._id}
                  leading={t.agentProvider ? <AgentMark provider={t.agentProvider} /> : <IconTile icon={Receipt} />}
                  title={t.title}
                  sub={t.reason}
                  trailing={
                    <div className="flex items-center gap-3">
                      <Money minor={t.amountMinor ?? 0} currency={t.currency ?? "USDC"} className="text-body font-semibold" />
                      {t.approvalToken && (
                        <ButtonLink href={approvalLink(t.approvalToken)} size="sm" external>
                          Review
                        </ButtonLink>
                      )}
                    </div>
                  }
                />
              ))}
              {attention.unknown.map((t) => (
                <Row
                  key={t._id}
                  leading={
                    <span className="grid size-10 place-items-center rounded-[12px] bg-amber-soft text-amber">
                      <LoaderCircle className="size-5 animate-spin [animation-duration:2s]" />
                    </span>
                  }
                  title={`${t.title} · ${t.payee ?? ""}`}
                  sub="Sent, waiting for confirmation"
                  trailing={<Money minor={t.amountMinor ?? 0} currency={t.currency ?? "USDC"} className="text-body font-semibold" />}
                />
              ))}
              {attention.familyRequests > 0 && (
                <Row
                  href="/family"
                  leading={<IconTile icon={Users} tone="green" />}
                  title={`${attention.familyRequests} family ${attention.familyRequests === 1 ? "request" : "requests"}`}
                  sub="Quote expires soon"
                  trailing={<span className="text-label font-semibold text-cyan-ink">Open</span>}
                />
              )}
              {o.suggested > 0 && (
                <Row
                  href="/money?tab=bills"
                  leading={<IconTile icon={Repeat} tone="sky" />}
                  title={`${o.suggested} regular ${o.suggested === 1 ? "payment" : "payments"} found`}
                  sub="Keep the real bills and subscriptions"
                  trailing={<span className="text-label font-semibold text-cyan-ink">Review</span>}
                />
              )}
              {attention.priceRises.map((p) => (
                <Row
                  key={p.name}
                  href="/money?tab=bills"
                  leading={<IconTile icon={TrendingUp} tone="red" />}
                  title={`${p.name} went up`}
                  sub={`${formatMoney(p.from, p.currency)} → ${formatMoney(p.to, p.currency)} a month`}
                />
              ))}
            </Divided>
          )}
        </Card>
      </div>

      <div className="min-w-0 space-y-4 lg:space-y-6 lg:pt-[54px]">
        <Card title="Coming up" action={<TextLink href="/money?tab=bills">All bills</TextLink>}>
          <Divided>
            {o.upcoming.slice(0, 4).map((b) => (
              <Row
                key={b._id}
                leading={<IconTile icon={b.kind === "bill" ? Receipt : Repeat} tone="page" />}
                title={b.name}
                sub={dueLabel(b.nextDueAt)}
                trailing={
                  <div className="flex flex-col items-end gap-0.5">
                    <Money minor={b.amountMinor} currency={b.currency} className="text-body font-semibold" hidden={hidden} />
                    {b.autopayLimitMinor !== undefined && <Chip tone="cyan">Autopay</Chip>}
                  </div>
                }
              />
            ))}
          </Divided>
        </Card>

        <Card title="This month" action={<TextLink href="/money">Details</TextLink>}>
          <div className="flex items-baseline justify-between">
            <span className="figure text-figure">{hidden ? "₹ ••••" : formatMoney(o.spentThisMonth, o.currency)}</span>
            <span className="num text-label text-mute">of {formatMoney(o.budget, o.currency)}</span>
          </div>
          <Meter
            value={o.spentThisMonth}
            max={o.budget}
            tone={o.spentThisMonth > o.budget ? "red" : o.spentThisMonth > o.budget * 0.8 ? "amber" : "cyan"}
            className="mt-2"
          />
          <div className="mt-4 space-y-2.5">
            {o.categories.slice(0, 5).map((c) => (
              <div key={c.name} className="grid grid-cols-[88px_1fr_auto] items-center gap-3">
                <span className="truncate text-label text-ink-2">{c.name}</span>
                <Meter value={c.amount} max={maxCategory} tone="navy" />
                <Money minor={c.amount} currency={o.currency} className="text-label font-semibold" hidden={hidden} />
              </div>
            ))}
          </div>
        </Card>

        <Card title="Recent" action={<TextLink href="/activity">All</TextLink>}>
          {recent === undefined ? (
            <Skeleton className="h-24" />
          ) : (
            <Divided>
              {recent.slice(0, 4).map((a) => (
                <Row key={a._id} leading={<ActivityIcon kind={a.kind} tone={a.tone} />} title={a.title} sub={ago(a._creationTime)} />
              ))}
            </Divided>
          )}
        </Card>
      </div>
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-6">
      <div className="space-y-4">
        <Skeleton className="h-[188px] rounded-card" />
        <Skeleton className="h-[196px] rounded-card" />
        <Skeleton className="h-[160px] rounded-card" />
      </div>
      <div className="space-y-4">
        <Skeleton className="h-[240px] rounded-card" />
        <Skeleton className="h-[220px] rounded-card" />
      </div>
    </div>
  );
}
