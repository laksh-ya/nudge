"use client";

import { usePaginatedQuery, useQuery } from "convex/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import {
  CreditCard,
  FileDown,
  Landmark,
  Laptop,
  Palmtree,
  Receipt,
  Repeat,
  Smartphone,
  Target,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ago, dueLabel, formatMoney, relativeDay } from "@/lib/format";
import { Button, Card, Chip, Divided, IconTile, Meter, Money, PageTitle, Row, Segmented, Skeleton } from "@/components/ui";

type Tab = "accounts" | "transactions" | "bills" | "goals";

const TABS: { value: Tab; label: string }[] = [
  { value: "accounts", label: "Accounts" },
  { value: "transactions", label: "Spending" },
  { value: "bills", label: "Bills" },
  { value: "goals", label: "Goals" },
];

export default function MoneyPage() {
  return (
    <Suspense>
      <Money_ />
    </Suspense>
  );
}

function Money_() {
  const params = useSearchParams();
  const router = useRouter();
  const raw = params.get("tab");
  const tab: Tab = TABS.some((t) => t.value === raw) ? (raw as Tab) : "transactions";
  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle>Money</PageTitle>
      <Segmented
        options={TABS}
        value={tab}
        onChange={(v) => router.replace(`/money?tab=${v}`, { scroll: false })}
        className="mb-4"
      />
      {tab === "accounts" && <Accounts />}
      {tab === "transactions" && <Transactions />}
      {tab === "bills" && <Bills />}
      {tab === "goals" && <Goals />}
    </div>
  );
}

const accountIcon: Record<string, LucideIcon> = { bank: Landmark, card: CreditCard, upi: Smartphone, wallet: Wallet, manual: FileDown };
const sourceLabel = { statement: "Statement", connected: "Connected", manual: "Manual" };

function Accounts() {
  const accounts = useQuery(api.money.accounts);
  if (!accounts) return <Skeleton className="h-64 rounded-card" />;
  return (
    <div className="space-y-4">
      <Card pad={false}>
        <Divided className="px-4">
          {accounts.map((a) => (
            <Row
              key={a._id}
              leading={<IconTile icon={accountIcon[a.kind] ?? Landmark} />}
              title={`${a.institution} ${a.name}`}
              sub={
                <span className="flex items-center gap-1.5">
                  {a.last4 && <span className="num">•• {a.last4}</span>}
                  <span>{sourceLabel[a.source]} · {ago(a.syncedAt)}</span>
                </span>
              }
              trailing={
                <div className="flex flex-col items-end gap-0.5">
                  <Money minor={a.balanceMinor} currency={a.currency} className={cn("text-body font-semibold", a.balanceMinor < 0 && "text-red")} />
                  <span className="text-micro text-mute">{a.can.includes("handoff") ? "Can open for payment" : "Read only"}</span>
                </div>
              }
            />
          ))}
        </Divided>
      </Card>
      <Card>
        <div className="flex items-center gap-3">
          <IconTile icon={FileDown} tone="page" />
          <div className="min-w-0 flex-1">
            <div className="text-body font-semibold">Import a statement</div>
            <div className="text-label text-mute">CSV or PDF from any bank, card or payment app</div>
          </div>
          <Button tone="outline" size="sm" disabled>
            Soon
          </Button>
        </div>
      </Card>
    </div>
  );
}

function Transactions() {
  const overview = useQuery(api.home.overview);
  const [category, setCategory] = useState<string | undefined>();
  const { results, status, loadMore } = usePaginatedQuery(api.money.transactions, { category }, { initialNumItems: 25 });

  const groups: { day: string; items: typeof results }[] = [];
  for (const t of results) {
    const day = relativeDay(t.at);
    const last = groups.at(-1);
    if (last?.day === day) last.items.push(t);
    else groups.push({ day, items: [t] });
  }

  return (
    <div className="space-y-4">
      {overview && (
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] lg:mx-0 lg:px-0">
          {[{ name: "All", amount: overview.overview.spentThisMonth }, ...overview.overview.categories].map((c) => {
            const on = c.name === "All" ? !category : category === c.name;
            return (
              <button
                key={c.name}
                onClick={() => setCategory(c.name === "All" ? undefined : c.name)}
                className={cn(
                  "press flex h-9 shrink-0 items-center gap-1.5 rounded-btn px-3 text-label font-semibold",
                  on ? "bg-navy text-white" : "bg-white text-ink-2 shadow-[var(--shadow-card)]",
                )}
              >
                {c.name}
                <span className={cn("num", on ? "text-white/70" : "text-mute")}>{formatMoney(c.amount, overview.overview.currency, { compact: true })}</span>
              </button>
            );
          })}
        </div>
      )}
      {status === "LoadingFirstPage" ? (
        <Skeleton className="h-96 rounded-card" />
      ) : (
        <Card pad={false} className="py-1">
          {groups.map((g) => (
            <div key={g.day}>
              <div className="sticky top-14 z-10 bg-white px-4 pt-3 pb-1 text-label font-semibold text-mute lg:top-0">{g.day}</div>
              <Divided className="px-4">
                {g.items.map((t) => (
                  <Row
                    key={t._id}
                    leading={<Initialish name={t.merchant} />}
                    title={t.merchant}
                    sub={
                      <span className="flex items-center gap-1.5">
                        {t.category}
                        {t.kind === "transfer" && <Chip>Own account</Chip>}
                        {t.status === "pending" && <Chip tone="amber">Pending</Chip>}
                      </span>
                    }
                    trailing={
                      <Money
                        minor={t.amountMinor}
                        currency={t.currency}
                        sign
                        className={cn("text-body font-semibold", t.amountMinor > 0 && "text-green")}
                      />
                    }
                  />
                ))}
              </Divided>
            </div>
          ))}
          {status === "CanLoadMore" && (
            <div className="p-3">
              <Button tone="ghost" className="w-full" onClick={() => loadMore(25)}>
                Show more
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function Initialish({ name }: { name: string }) {
  return (
    <span className="grid size-10 shrink-0 place-items-center rounded-full bg-page text-label font-bold text-navy">
      {name.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase()}
    </span>
  );
}

function Bills() {
  const bills = useQuery(api.money.obligations);
  if (!bills) return <Skeleton className="h-96 rounded-card" />;
  const active = bills.filter((b) => b.status === "active");
  const monthly = active.reduce((s, b) => s + (b.cadence === "yearly" ? Math.round(b.amountMinor / 12) : b.cadence === "weekly" ? b.amountMinor * 4 : b.amountMinor), 0);
  const currency = active[0]?.currency ?? "INR";
  const section = (kind: "bill" | "subscription") => active.filter((b) => b.kind === kind);
  return (
    <div className="space-y-4">
      <Card>
        <div className="text-label text-mute">Every month, on average</div>
        <div className="figure mt-0.5 text-figure">{formatMoney(Math.round(monthly / 100) * 100, currency)}</div>
      </Card>
      {(["bill", "subscription"] as const).map((kind) => (
        <Card key={kind} title={kind === "bill" ? "Bills" : "Subscriptions"} pad={false}>
          <Divided className="px-4 pb-1">
            {section(kind).map((b) => {
              const rose = b.previousAmountMinor !== undefined && b.amountMinor > b.previousAmountMinor;
              return (
                <Row
                  key={b._id}
                  leading={<IconTile icon={kind === "bill" ? Receipt : Repeat} tone={rose ? "red" : "page"} />}
                  title={b.name}
                  sub={
                    <span className="flex items-center gap-1.5">
                      {dueLabel(b.nextDueAt)}
                      {b.cadence === "yearly" && <span>· yearly</span>}
                    </span>
                  }
                  trailing={
                    <div className="flex flex-col items-end gap-0.5">
                      <Money minor={b.amountMinor} currency={b.currency} className="text-body font-semibold" />
                      {rose ? (
                        <Chip tone="red">Was {formatMoney(b.previousAmountMinor!, b.currency)}</Chip>
                      ) : b.autopayLimitMinor !== undefined ? (
                        <Chip tone="cyan">Autopay up to {formatMoney(b.autopayLimitMinor, b.currency)}</Chip>
                      ) : null}
                    </div>
                  }
                />
              );
            })}
          </Divided>
        </Card>
      ))}
    </div>
  );
}

const goalIcon: Record<string, LucideIcon> = { palmtree: Palmtree, laptop: Laptop };

function Goals() {
  const goals = useQuery(api.money.goals);
  if (!goals) return <Skeleton className="h-64 rounded-card" />;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {goals.map((g) => (
        <Card key={g._id}>
          <div className="flex items-center gap-3">
            <IconTile icon={goalIcon[g.icon] ?? Target} />
            <div className="min-w-0">
              <div className="truncate text-body font-semibold">{g.name}</div>
              <div className="text-label text-mute">{Math.round((g.savedMinor / g.targetMinor) * 100)}% saved</div>
            </div>
          </div>
          <div className="mt-4 flex items-baseline justify-between">
            <span className="figure text-figure">{formatMoney(g.savedMinor, g.currency)}</span>
            <span className="num text-label text-mute">of {formatMoney(g.targetMinor, g.currency)}</span>
          </div>
          <Meter value={g.savedMinor} max={g.targetMinor} tone="green" className="mt-2" />
        </Card>
      ))}
    </div>
  );
}
