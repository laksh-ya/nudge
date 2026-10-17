"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Bell, Check, Plus, Receipt, Target, Trash2, X } from "lucide-react";
import type { Currency } from "@agent-wallet/domain";
import { api, type Id } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { Button, Card, Chip, Divided, Empty, IconTile, Money, PageTitle, Row, Segmented, Sheet, Skeleton } from "@/components/ui";
import { ErrorText, Field, Input, MoneyInput, Select, errorMessage, toMinorUnits } from "@/components/form";

const DAY = 86_400_000;
const day = (at: number) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const isoDay = (at: number) => new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

/**
 * Plan: what's coming in and going out, and where that leaves you. Nothing here is counted as
 * received until you mark it, and your assistant (in the app, on Telegram or over MCP) reads the
 * same plan to answer "will I make it to payday?".
 */
export default function PlanPage() {
  const [days, setDays] = useState<"30" | "60" | "90">("60");
  const p = useQuery(api.plan.projection, { days: Number(days) });
  const [adding, setAdding] = useState<"income" | "expense" | null>(null);
  const [reminding, setReminding] = useState(false);
  if (p === undefined) return <Skeleton className="mx-auto h-96 max-w-3xl rounded-card" />;
  if (p === null) return null;
  const cur = p.currency as Currency;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageTitle action={<Segmented options={[{ value: "30", label: "30 days" }, { value: "60", label: "60" }, { value: "90", label: "90" }]} value={days} onChange={setDays} />}>
        Plan
      </PageTitle>
      <Card>
        <div className="grid grid-cols-3 gap-3">
          <Figure label="Safe to spend now" minor={p.startMinor} currency={cur} />
          <Figure label={`In ${days} days`} minor={p.endMinor} currency={cur} />
          <Figure label="Lowest point" minor={p.lowestMinor} currency={cur} tone={p.lowestMinor < 0 ? "red" : undefined} />
        </div>
        <Spark points={p.points} />
        <p className="mt-2 text-label text-mute">
          Next payday {day(p.nextIncomeAt)}. Starts from what's safe to spend after bills before payday and your emergency fund; adds expected income on its
          date and takes away later bills and planned spends.
        </p>
      </Card>

      <Card
        title="Coming in"
        action={
          <Button size="sm" tone="outline" icon={Plus} onClick={() => setAdding("income")}>
            Add
          </Button>
        }
        pad={false}
      >
        <Events items={p.events.filter((e) => e.kind === "income")} currency={cur} empty="Add your salary or anything you expect to receive. It's only counted once you mark it received." />
      </Card>

      <Card
        title="Going out"
        action={
          <Button size="sm" tone="outline" icon={Plus} onClick={() => setAdding("expense")}>
            Add
          </Button>
        }
        pad={false}
      >
        <Events items={p.events.filter((e) => e.kind !== "income")} currency={cur} empty="Bills after payday and anything you plan to spend (a trip, a deposit) show up here." />
      </Card>

      {p.goals.length > 0 && (
        <Card title="Goals" pad={false}>
          <Divided className="px-4 pb-1">
            {p.goals.map((g) => (
              <Row
                key={g._id}
                leading={<IconTile icon={Target} tone="page" />}
                title={g.name}
                sub={`${formatMoney(g.savedMinor, g.currency)} of ${formatMoney(g.targetMinor, g.currency)}${g.plan.monthly ? ` · ${formatMoney(g.plan.monthly, g.currency)} a month to make it` : ""}`}
                trailing={<Chip tone={g.savedMinor >= g.targetMinor ? "green" : "neutral"}>{g.targetMinor ? Math.min(100, Math.floor((g.savedMinor / g.targetMinor) * 100)) : 0}%</Chip>}
              />
            ))}
          </Divided>
        </Card>
      )}

      <Reminders onAdd={() => setReminding(true)} />

      {adding && <AddPlanSheet kind={adding} currency={cur} onClose={() => setAdding(null)} />}
      {reminding && <ReminderSheet onClose={() => setReminding(false)} />}
    </div>
  );
}

function Figure({ label, minor, currency, tone }: { label: string; minor: number; currency: Currency; tone?: "red" }) {
  return (
    <div>
      <div className="text-label text-mute">{label}</div>
      <Money minor={minor} currency={currency} className={`text-title font-semibold ${tone === "red" ? "text-red" : "text-ink"}`} />
    </div>
  );
}

/** The projected balance as a step line. */
function Spark({ points }: { points: { at: number; balanceMinor: number }[] }) {
  if (points.length < 2) return null;
  const W = 600;
  const H = 90;
  const t0 = points[0]!.at;
  const t1 = points[points.length - 1]!.at;
  const vals = points.map((p) => p.balanceMinor);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(...vals, 1);
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (v: number) => H - 6 - ((v - lo) / Math.max(1, hi - lo)) * (H - 12);
  let d = `M0,${y(points[0]!.balanceMinor)}`;
  for (let i = 1; i < points.length; i++) d += ` H${x(points[i]!.at)} V${y(points[i]!.balanceMinor)}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 h-24 w-full" preserveAspectRatio="none" role="img" aria-label="Projected balance">
      {lo < 0 && <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="currentColor" className="text-red/40" strokeDasharray="4 4" />}
      <path d={d} fill="none" stroke="currentColor" strokeWidth={2.5} className="text-cyan" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

type Ev = { at: number; name: string; amountMinor: number; kind: "income" | "bill" | "expense"; currency: string; counted: boolean; planId?: string };

function Events({ items, currency, empty }: { items: Ev[]; currency: Currency; empty: string }) {
  const done = useMutation(api.plan.markDone);
  const remove = useMutation(api.plan.remove);
  if (!items.length) return <Empty>{empty}</Empty>;
  return (
    <Divided className="px-4 pb-1">
      {items.map((e, i) => (
        <Row
          key={`${e.planId ?? e.name}-${e.at}-${i}`}
          leading={<IconTile icon={e.kind === "income" ? ArrowDownLeft : e.kind === "bill" ? Receipt : ArrowUpRight} tone={e.kind === "income" ? "green" : "page"} />}
          title={e.name}
          sub={`${day(e.at)}${e.kind === "bill" ? " · bill" : ""}${e.counted ? "" : " · other currency, not in the line"}`}
          trailing={
            <span className="flex items-center gap-2">
              <Money minor={e.amountMinor} currency={(e.currency || currency) as Currency} sign className="text-body font-semibold" />
              {e.planId && (
                <>
                  <button className="press text-green" aria-label={e.kind === "income" ? "Mark received" : "Mark paid"} title={e.kind === "income" ? "Received" : "Paid"} onClick={() => done({ id: e.planId as Id<"plans"> })}>
                    <Check className="size-4" />
                  </button>
                  <button className="press text-mute" aria-label="Remove" onClick={() => remove({ id: e.planId as Id<"plans"> })}>
                    <Trash2 className="size-4" />
                  </button>
                </>
              )}
            </span>
          }
        />
      ))}
    </Divided>
  );
}

function AddPlanSheet({ kind, currency, onClose }: { kind: "income" | "expense"; currency: Currency; onClose: () => void }) {
  const add = useMutation(api.plan.add);
  const [form, setForm] = useState({ name: kind === "income" ? "Salary" : "", amount: "", date: isoDay(Date.now() + 7 * DAY), repeat: kind === "income" ? "monthly" : "" });
  const [error, setError] = useState<string>();
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={kind === "income" ? "Money coming in" : "Planned spend"}>
      <form
        className="space-y-3 pb-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(undefined);
          try {
            await add({ kind, name: form.name, amountMinor: toMinorUnits(form.amount, currency) ?? 0, dueAt: new Date(`${form.date}T09:00:00`).getTime(), repeat: (form.repeat || undefined) as "monthly" | "weekly" | undefined });
            onClose();
          } catch (err) {
            setError(errorMessage(err));
          }
        }}
      >
        <Field label="What">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={kind === "income" ? "Salary, freelance invoice, refund" : "Trip to Goa, rent deposit"} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount">
            <MoneyInput currency={currency} value={form.amount} onChange={(amount) => setForm({ ...form, amount })} />
          </Field>
          <Field label="When">
            <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </Field>
        </div>
        <Field label="Repeats">
          <Select value={form.repeat} onChange={(e) => setForm({ ...form, repeat: e.target.value })}>
            <option value="">Once</option>
            <option value="monthly">Every month</option>
            <option value="weekly">Every week</option>
          </Select>
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" size="lg" className="w-full" disabled={!form.name || !form.amount}>
          Add
        </Button>
      </form>
    </Sheet>
  );
}

function Reminders({ onAdd }: { onAdd: () => void }) {
  const rows = useQuery(api.reminders.list);
  const cancel = useMutation(api.reminders.cancel);
  return (
    <Card
      title="Reminders"
      action={
        <Button size="sm" tone="outline" icon={Plus} onClick={onAdd}>
          Add
        </Button>
      }
      pad={false}
    >
      {!rows?.length ? (
        <Empty>No reminders. Add one here, or tell your assistant "remind me to pay rent on the 1st". Bills are reminded automatically.</Empty>
      ) : (
        <Divided className="px-4 pb-1">
          {rows.map((r) => (
            <Row
              key={r._id}
              leading={<IconTile icon={Bell} tone="page" />}
              title={r.text}
              sub={`${r.when}${r.repeat ? ` · every ${r.repeat === "monthly" ? "month" : "week"}` : ""}`}
              trailing={
                <button className="press text-mute" aria-label={`Cancel ${r.text}`} onClick={() => cancel({ reminderId: r._id })}>
                  <X className="size-4" />
                </button>
              }
            />
          ))}
        </Divided>
      )}
    </Card>
  );
}

function ReminderSheet({ onClose }: { onClose: () => void }) {
  const create = useMutation(api.reminders.create);
  const bills = useQuery(api.money.obligations);
  const [form, setForm] = useState({ text: "", date: isoDay(Date.now() + DAY), time: "09:00", repeat: "", bill: "" });
  const [error, setError] = useState<string>();
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title="New reminder">
      <form
        className="space-y-3 pb-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(undefined);
          try {
            await create({
              text: form.text,
              dueAt: new Date(`${form.date}T${form.time}:00`).getTime(),
              repeat: (form.repeat || undefined) as "monthly" | "weekly" | undefined,
              obligationId: (form.bill || undefined) as Id<"obligations"> | undefined,
            });
            onClose();
          } catch (err) {
            setError(errorMessage(err));
          }
        }}
      >
        <Field label="Remind me to">
          <Input value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} placeholder="Pay rent" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Day">
            <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </Field>
          <Field label="Time">
            <Input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Repeats">
            <Select value={form.repeat} onChange={(e) => setForm({ ...form, repeat: e.target.value })}>
              <option value="">Once</option>
              <option value="monthly">Every month</option>
              <option value="weekly">Every week</option>
            </Select>
          </Field>
          <Field label="About a bill (optional)">
            <Select value={form.bill} onChange={(e) => setForm({ ...form, bill: e.target.value, text: form.text || bills?.find((b) => b._id === e.target.value)?.name || "" })}>
              <option value="">None</option>
              {(bills ?? [])
                .filter((b) => b.status === "active")
                .map((b) => (
                  <option key={b._id} value={b._id}>
                    {b.name}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" size="lg" className="w-full" disabled={!form.text}>
          Set reminder
        </Button>
      </form>
    </Sheet>
  );
}
