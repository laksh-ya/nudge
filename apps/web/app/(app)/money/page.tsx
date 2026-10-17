"use client";

import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Laptop, Palmtree, Plane, Plus, Receipt, Repeat, Target, Home as HomeIcon, Car, GraduationCap, type LucideIcon } from "lucide-react";
import { formatMoney, type Currency, type SourceKind } from "@agent-wallet/domain";
import { api, type Id } from "@/lib/api";
import { cn } from "@/lib/cn";
import { dueLabel, relativeDay } from "@/lib/format";
import { AccountRow, type AccountView } from "@/components/connect/account-row";
import { AddSourceSheet, KIND_META } from "@/components/connect/add-source";
import { TransactionSheet } from "@/components/money/transaction-sheet";
import { Initials } from "@/components/money/initials";
import { ErrorText, Field, Input, MoneyInput, Select, errorMessage, toMinorUnits } from "@/components/form";
import { Button, Card, Chip, Divided, IconTile, Meter, Money, PageTitle, Row, Segmented, Sheet, Skeleton } from "@/components/ui";

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
      <MoneyTabs />
    </Suspense>
  );
}

function MoneyTabs() {
  const params = useSearchParams();
  const router = useRouter();
  const raw = params.get("tab");
  const tab: Tab = TABS.some((t) => t.value === raw) ? (raw as Tab) : "transactions";
  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle>Money</PageTitle>
      <Segmented options={TABS} value={tab} onChange={(v) => router.replace(`/money?tab=${v}`, { scroll: false })} className="mb-4" />
      {tab === "accounts" && <Accounts />}
      {tab === "transactions" && <Transactions />}
      {tab === "bills" && <Bills />}
      {tab === "goals" && <Goals />}
    </div>
  );
}

const ORDER: SourceKind[] = ["bank", "card", "payment_app", "transfer", "crypto", "cash"];

function Accounts() {
  const accounts = useQuery(api.connections.list);
  const home = useQuery(api.home.overview);
  const [adding, setAdding] = useState(0);
  if (!accounts || !home) return <Skeleton className="h-64 rounded-card" />;
  const o = home.overview;
  return (
    <div className="space-y-4">
      <section className="rise overflow-hidden rounded-card bg-navy text-white">
        <div className="p-5">
          <div className="text-label text-white/70">Net worth</div>
          <div className="figure mt-0.5 text-hero">{formatMoney(o.netWorth, o.currency)}</div>
          <div className="mt-1 text-label text-white/60">
            {accounts.length} {accounts.length === 1 ? "account" : "accounts"} · converted at {o.ratesDate} rates
            {o.unconverted.length > 0 && <> · no rate for {o.unconverted.join(", ")}, left out</>}
            {o.partial && <> · totals are partial</>}
          </div>
        </div>
        <div className="grid grid-cols-3 border-t border-white/10 text-label">
          {[
            ["Cash", o.cash],
            ["Cards owed", -o.cardDue],
            ["Crypto", o.cryptoValue],
          ].map(([l, v]) => (
            <div key={l as string} className="border-r border-white/10 px-4 py-3 last:border-r-0">
              <div className="text-white/60">{l}</div>
              <div className="num mt-0.5 font-semibold">{formatMoney(v as number, o.currency, { compact: Math.abs(v as number) > 1e8 })}</div>
            </div>
          ))}
        </div>
      </section>

      {ORDER.map((kind) => {
        const list = accounts.filter((a) => a.kind === kind);
        if (list.length === 0) return null;
        return (
          <Card key={kind} title={KIND_META[kind].label} pad={false}>
            <Divided className="px-4 pb-1">
              {list.map((a) => (
                <AccountRow key={a._id} account={a as AccountView} href={`/money/accounts/${a._id}`} />
              ))}
            </Divided>
          </Card>
        );
      })}

      <Button size="lg" tone="outline" icon={Plus} className="w-full" onClick={() => setAdding((n) => n + 1)}>
        Add a money source
      </Button>
      {adding > 0 && <AddSourceSheet key={adding} open onOpenChange={(o) => !o && setAdding(0)} />}
    </div>
  );
}

function Transactions() {
  const overview = useQuery(api.home.overview);
  const [category, setCategory] = useState<string | undefined>();
  const [open, setOpen] = useState<Id<"transactions"> | null>(null);
  const { results, status, loadMore } = usePaginatedQuery(api.money.transactions, { category }, { initialNumItems: 30 });

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
      ) : results.length === 0 ? (
        <Card>
          <p className="py-4 text-center text-body text-mute">No transactions yet. Add history from Accounts.</p>
        </Card>
      ) : (
        <Card pad={false} className="py-1">
          {groups.map((g) => (
            <div key={g.day}>
              <div className="sticky top-14 z-10 bg-white px-4 pt-3 pb-1 text-label font-semibold text-mute lg:top-0">{g.day}</div>
              <Divided className="px-4">
                {g.items.map((t) => (
                  <Row
                    key={t._id}
                    onClick={() => setOpen(t._id)}
                    className={cn(t.duplicateOf && "opacity-50")}
                    leading={<Initials name={t.merchant} />}
                    title={t.merchant}
                    sub={
                      <span className="flex items-center gap-1.5">
                        {t.category}
                        {t.kind === "transfer" && <Chip>Own account</Chip>}
                        {t.duplicateOf && <Chip>Counted once</Chip>}
                        {t.status === "pending" && <Chip tone="amber">Pending</Chip>}
                        {t.receiptId && <Chip tone="cyan">Receipt</Chip>}
                      </span>
                    }
                    trailing={<Money minor={t.amountMinor} currency={t.currency} sign className={cn("text-body font-semibold", t.amountMinor > 0 && "text-green")} />}
                  />
                ))}
              </Divided>
            </div>
          ))}
          {status === "CanLoadMore" && (
            <div className="p-3">
              <Button tone="ghost" className="w-full" onClick={() => loadMore(30)}>
                Show more
              </Button>
            </div>
          )}
        </Card>
      )}
      <TransactionSheet id={open} onClose={() => setOpen(null)} />
    </div>
  );
}


function monthlyOf(b: { amountMinor: number; cadence: "weekly" | "monthly" | "yearly" }) {
  return b.cadence === "yearly" ? Math.round(b.amountMinor / 12) : b.cadence === "weekly" ? Math.round((b.amountMinor * 52) / 12) : b.amountMinor;
}

function Bills() {
  const bills = useQuery(api.money.obligations);
  const me = useQuery(api.users.me);
  const review = useMutation(api.money.reviewSuggestion);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Id<"obligations"> | null>(null);
  if (!bills || !me) return <Skeleton className="h-96 rounded-card" />;
  const active = bills.filter((b) => b.status === "active");
  const suggested = bills.filter((b) => b.status === "suggested");
  const monthly = active.filter((b) => b.currency === me.currency).reduce((s, b) => s + monthlyOf(b), 0);
  const section = (kind: "bill" | "subscription") => active.filter((b) => b.kind === kind);
  const edit = bills.find((b) => b._id === editing);
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="text-label text-mute">Every month, on average</div>
            <div className="figure mt-0.5 text-figure">{formatMoney(Math.round(monthly / 100) * 100, me.currency as Currency)}</div>
          </div>
          <Button size="sm" tone="outline" icon={Plus} onClick={() => setAdding(true)}>
            Add
          </Button>
        </div>
      </Card>

      {suggested.length > 0 && (
        <Card title={`Found in your history · ${suggested.length}`} className="border-l-4 border-cyan">
          <Divided>
            {suggested.map((b) => (
              <div key={b._id} className="flex items-center gap-3 py-2.5">
                <IconTile icon={Repeat} tone="page" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body font-medium">{b.name}</div>
                  <div className="text-label text-mute">
                    {b.cadence} · seen {b.occurrences ?? 2}× · {formatMoney(b.amountMinor, b.currency)}
                  </div>
                </div>
                <button onClick={() => review({ id: b._id, keep: false })} className="press h-8 rounded-btn px-2.5 text-label font-semibold text-mute hover:bg-page">
                  Not a bill
                </button>
                <button onClick={() => review({ id: b._id, keep: true })} className="press h-8 rounded-btn bg-navy px-3 text-label font-semibold text-white">
                  Keep
                </button>
              </div>
            ))}
          </Divided>
        </Card>
      )}

      {(["bill", "subscription"] as const).map((kind) =>
        section(kind).length === 0 ? null : (
          <Card key={kind} title={kind === "bill" ? "Bills" : "Subscriptions"} pad={false}>
            <Divided className="px-4 pb-1">
              {section(kind).map((b) => {
                const rose = b.previousAmountMinor !== undefined && b.amountMinor > b.previousAmountMinor;
                return (
                  <Row
                    key={b._id}
                    onClick={() => setEditing(b._id)}
                    leading={<IconTile icon={kind === "bill" ? Receipt : Repeat} tone={rose ? "red" : "page"} />}
                    title={b.name}
                    sub={`${dueLabel(b.nextDueAt)}${b.cadence !== "monthly" ? ` · ${b.cadence}` : ""}`}
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
        ),
      )}
      {active.length === 0 && suggested.length === 0 && (
        <Card>
          <p className="py-4 text-center text-body text-mute">No bills yet. Add rent, electricity or a subscription with Add, and choose who it's paid to and how.</p>
        </Card>
      )}
      <AddBillSheet open={adding} onOpenChange={setAdding} currency={me.currency as Currency} />
      {edit && <EditBillSheet bill={edit} onClose={() => setEditing(null)} />}
    </div>
  );
}

type PayWith = "manual" | "account" | "wallet";

/** Who a bill is paid to and how: by hand (Nudge reminds), from an account or card, or from the Nudge wallet. */
function PaymentFields({
  value,
  onChange,
}: {
  value: { payWith: PayWith; payeeId: string; accountId: string };
  onChange: (v: { payWith: PayWith; payeeId: string; accountId: string }) => void;
}) {
  const wallet = useQuery(api.wallet.get);
  const accounts = useQuery(api.money.accounts);
  const payees = wallet?.payees ?? [];
  const payable = (accounts ?? []).filter((a) => a.kind === "bank" || a.kind === "card" || a.kind === "cash");
  return (
    <div className="space-y-3 rounded-btn border border-line p-3">
      <Field label="Paid from">
        <Segmented
          options={[
            { value: "manual", label: "I pay it" },
            { value: "account", label: "Account" },
            { value: "wallet", label: "Nudge wallet" },
          ]}
          value={value.payWith}
          onChange={(payWith) => onChange({ ...value, payWith })}
        />
      </Field>
      {value.payWith === "account" && (
        <Field label="Account or card">
          <Select value={value.accountId} onChange={(e) => onChange({ ...value, accountId: e.target.value })}>
            <option value="">Pick one</option>
            {payable.map((a) => (
              <option key={a._id} value={a._id}>
                {a.name}
                {a.last4 ? ` ·· ${a.last4}` : ""}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label={value.payWith === "wallet" ? "Paid to (a contact)" : "Paid to (optional)"}>
        <Select value={value.payeeId} onChange={(e) => onChange({ ...value, payeeId: e.target.value })}>
          <option value="">{value.payWith === "wallet" ? "Pick a contact" : "Nobody saved"}</option>
          {payees.map((p) => (
            <option key={p._id} value={p._id}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>
      <p className="text-label text-mute">
        {value.payWith === "wallet"
          ? "In test dollars. When it's due, your assistant can pay it within its limits, or asks you with a passkey link."
          : value.payWith === "account"
            ? "Nudge reminds you before it's due and opens the payment for you to finish in your bank's app."
            : "Nudge reminds you before it's due. Mark it paid when you've paid it."}
      </p>
    </div>
  );
}

function AddBillSheet({ open, onOpenChange, currency }: { open: boolean; onOpenChange: (o: boolean) => void; currency: Currency }) {
  const add = useMutation(api.money.addObligation);
  const [form, setForm] = useState({ name: "", amount: "", kind: "bill" as "bill" | "subscription", cadence: "monthly" as "weekly" | "monthly" | "yearly", due: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10) });
  const [pay, setPay] = useState({ payWith: "manual" as PayWith, payeeId: "", accountId: "" });
  const [error, setError] = useState<string>();
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Add a bill">
      <form
        className="space-y-3 pb-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(undefined);
          try {
            const billCurrency = pay.payWith === "wallet" ? "USD" : currency;
            await add({
              name: form.name,
              kind: form.kind,
              cadence: form.cadence,
              amountMinor: toMinorUnits(form.amount, billCurrency) ?? 0,
              nextDueAt: new Date(`${form.due}T06:00:00Z`).getTime(),
              payWith: pay.payWith,
              payeeId: (pay.payeeId || undefined) as Id<"payees"> | undefined,
              accountId: (pay.accountId || undefined) as Id<"accounts"> | undefined,
            });
            onOpenChange(false);
            setForm({ ...form, name: "", amount: "" });
          } catch (err) {
            setError(errorMessage(err));
          }
        }}
      >
        <Segmented options={[{ value: "bill", label: "Bill" }, { value: "subscription", label: "Subscription" }]} value={form.kind} onChange={(kind) => setForm({ ...form, kind })} />
        <Field label="Name">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Electricity" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount">
            <MoneyInput currency={currency} value={form.amount} onChange={(amount) => setForm({ ...form, amount })} />
          </Field>
          <Field label="Repeats">
            <Select value={form.cadence} onChange={(e) => setForm({ ...form, cadence: e.target.value as typeof form.cadence })}>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </Select>
          </Field>
        </div>
        <Field label="Next due">
          <Input type="date" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} />
        </Field>
        <PaymentFields value={pay} onChange={setPay} />
        <ErrorText>{error}</ErrorText>
        <Button type="submit" size="lg" className="w-full" disabled={!form.name || !form.amount}>
          Add
        </Button>
      </form>
    </Sheet>
  );
}

function EditBillSheet({
  bill,
  onClose,
}: {
  bill: {
    _id: Id<"obligations">;
    name: string;
    amountMinor: number;
    currency: Currency;
    autopayLimitMinor?: number;
    nextDueAt: number;
    cadence: string;
    payWith?: PayWith;
    payeeId?: Id<"payees">;
    accountId?: Id<"accounts">;
  };
  onClose: () => void;
}) {
  const update = useMutation(api.money.updateObligation);
  const [limit, setLimit] = useState(bill.autopayLimitMinor ? String(bill.autopayLimitMinor / 100) : "");
  const [amount, setAmount] = useState(String(bill.amountMinor / 100));
  const [due, setDue] = useState(new Date(bill.nextDueAt).toISOString().slice(0, 10));
  const [pay, setPay] = useState({ payWith: bill.payWith ?? ("manual" as PayWith), payeeId: bill.payeeId ?? "", accountId: bill.accountId ?? "" });
  const [error, setError] = useState<string>();
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={bill.name}>
      <div className="space-y-4 pb-4">
        <div>
          <div className="figure text-figure">{formatMoney(bill.amountMinor, bill.currency)}</div>
          <div className="text-label text-mute">
            {bill.cadence} · {dueLabel(bill.nextDueAt)}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount">
            <MoneyInput currency={bill.currency} value={amount} onChange={setAmount} />
          </Field>
          <Field label="Next due">
            <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
        </div>
        <PaymentFields value={pay} onChange={setPay} />
        <Field label="Pay automatically up to" hint="If the bill comes in higher, you'll be asked first. Leave empty to approve every time.">
          <MoneyInput currency={bill.currency} value={limit} onChange={setLimit} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="grid grid-cols-2 gap-2">
          <Button
            tone="danger"
            size="lg"
            onClick={async () => {
              await update({ id: bill._id, status: "cancelled" });
              onClose();
            }}
          >
            Stop tracking
          </Button>
          <Button
            size="lg"
            onClick={async () => {
              setError(undefined);
              try {
                await update({
                  id: bill._id,
                  autopayLimitMinor: limit ? toMinorUnits(limit, bill.currency) : null,
                  amountMinor: toMinorUnits(amount, bill.currency) ?? bill.amountMinor,
                  nextDueAt: new Date(`${due}T06:00:00Z`).getTime(),
                  payWith: pay.payWith,
                  payeeId: (pay.payeeId || null) as Id<"payees"> | null,
                  accountId: (pay.accountId || null) as Id<"accounts"> | null,
                });
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

const GOAL_ICONS: Record<string, LucideIcon> = { palmtree: Palmtree, laptop: Laptop, plane: Plane, home: HomeIcon, car: Car, study: GraduationCap, target: Target };

function Goals() {
  const goals = useQuery(api.money.goals);
  const me = useQuery(api.users.me);
  const addGoal = useMutation(api.money.addGoal);
  const contribute = useMutation(api.money.contribute);
  const [adding, setAdding] = useState(false);
  const [topUp, setTopUp] = useState<Id<"goals"> | null>(null);
  const [form, setForm] = useState({ name: "", target: "", icon: "target" });
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string>();
  if (!goals || !me) return <Skeleton className="h-64 rounded-card" />;
  const currency = me.currency as Currency;
  const target = goals.find((g) => g._id === topUp);
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        {goals.map((g) => {
          const Icon = GOAL_ICONS[g.icon] ?? Target;
          const done = g.savedMinor >= g.targetMinor;
          return (
            <Card key={g._id}>
              <div className="flex items-center gap-3">
                <IconTile icon={Icon} tone={done ? "green" : "sky"} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body font-semibold">{g.name}</div>
                  <div className="text-label text-mute">{done ? "Reached" : `${Math.round((g.savedMinor / g.targetMinor) * 100)}% saved`}</div>
                </div>
                <Button size="sm" tone="outline" onClick={() => { setAmount(""); setTopUp(g._id); }}>
                  Add
                </Button>
              </div>
              <div className="mt-4 flex items-baseline justify-between">
                <span className="figure text-figure">{formatMoney(g.savedMinor, g.currency)}</span>
                <span className="num text-label text-mute">of {formatMoney(g.targetMinor, g.currency)}</span>
              </div>
              <Meter value={g.savedMinor} max={g.targetMinor} tone="green" className="mt-2" />
            </Card>
          );
        })}
        <button onClick={() => setAdding(true)} className="press card flex min-h-[152px] flex-col items-center justify-center gap-2 border-2 border-dashed border-line text-navy hover:border-cyan">
          <Plus className="size-6" />
          <span className="text-body font-semibold">New goal</span>
        </button>
      </div>

      <Sheet open={adding} onOpenChange={setAdding} title="New goal">
        <form
          className="space-y-3 pb-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(undefined);
            try {
              await addGoal({ name: form.name, icon: form.icon, targetMinor: toMinorUnits(form.target, currency) ?? 0 });
              setAdding(false);
              setForm({ name: "", target: "", icon: "target" });
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        >
          <div className="flex gap-2">
            {Object.entries(GOAL_ICONS).map(([k, Icon]) => (
              <button
                type="button"
                key={k}
                onClick={() => setForm({ ...form, icon: k })}
                className={cn("press grid size-10 place-items-center rounded-[12px]", form.icon === k ? "bg-navy text-white" : "bg-page text-navy")}
              >
                <Icon className="size-5" />
              </button>
            ))}
          </div>
          <Field label="Saving for">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Trip to Goa" />
          </Field>
          <Field label="Target">
            <MoneyInput currency={currency} value={form.target} onChange={(t) => setForm({ ...form, target: t })} />
          </Field>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" size="lg" className="w-full" disabled={!form.name || !form.target}>
            Create goal
          </Button>
        </form>
      </Sheet>

      <Sheet open={Boolean(target)} onOpenChange={(o) => !o && setTopUp(null)} title={target ? `Add to ${target.name}` : ""}>
        <form
          className="space-y-3 pb-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!target) return;
            await contribute({ goalId: target._id, amountMinor: toMinorUnits(amount, currency) ?? 0 });
            setTopUp(null);
          }}
        >
          <MoneyInput currency={currency} value={amount} onChange={setAmount} autoFocus />
          <div className="flex gap-2">
            {[500, 1000, 5000].map((v) => (
              <button type="button" key={v} onClick={() => setAmount(String(v))} className="press h-8 flex-1 rounded-btn bg-page text-label font-semibold text-navy">
                {formatMoney(v * 100, currency)}
              </button>
            ))}
          </div>
          <Button type="submit" size="lg" className="w-full" disabled={!amount}>
            Add
          </Button>
        </form>
      </Sheet>
    </>
  );
}
