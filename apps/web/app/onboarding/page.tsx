"use client";

import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  Camera,
  Check,
  Copy,
  FileSpreadsheet,
  Fingerprint,
  LoaderCircle,
  MessageCircle,
  PenLine,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  UserPlus,
} from "lucide-react";
import {
  COUNTRIES,
  FIAT_CODES,
  PRIORITIES,
  country as countryInfo,
  formatMoney,
  type Currency,
  type SourceKind,
} from "@agent-wallet/domain";
import { api, type Id } from "@/lib/api";
import { cn } from "@/lib/cn";
import { approvalLink } from "@/lib/config";
import { useDemo } from "@/lib/demo";
import { dueLabel, fmtAmount } from "@/lib/format";
import { AgentMark, Wordmark } from "@/components/brand";
import { AccountRow, type AccountView } from "@/components/connect/account-row";
import { AddSourceSheet, KIND_META } from "@/components/connect/add-source";
import { HistorySheet, type HistoryMode } from "@/components/connect/history-sheet";
import { Choice, ErrorText, Field, Input, MoneyInput, Select, errorMessage, fromMinorUnits, toMinorUnits } from "@/components/form";
import { Button, Chip, Divided, IconTile, Skeleton } from "@/components/ui";

const STEPS = [
  { id: "you", title: "About you" },
  { id: "goals", title: "What matters to you" },
  { id: "sources", title: "Add your money" },
  { id: "history", title: "Bring in your history" },
  { id: "review", title: "Your money at a glance" },
  { id: "assistant", title: "Your assistant" },
  { id: "wallet", title: "Agent wallet" },
  { id: "chat", title: "Chat with your assistant" },
  { id: "people", title: "Assistants and family" },
  { id: "done", title: "You're set" },
] as const;

type StepId = (typeof STEPS)[number]["id"];

export default function Onboarding() {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { demo, loaded } = useDemo();
  const ensure = useMutation(api.users.ensure);
  const state = useQuery(api.onboarding.state);
  const setStepRemote = useMutation(api.onboarding.setStep);
  const complete = useMutation(api.onboarding.complete);
  const [local, setLocal] = useState<StepId | null>(null);

  // Settings links straight to one step, e.g. /onboarding?step=chat for Telegram.
  useEffect(() => {
    const want = new URLSearchParams(window.location.search).get("step");
    if (want && STEPS.some((s) => s.id === want)) setLocal(want as StepId);
  }, []);

  useEffect(() => {
    if (isAuthenticated) void ensure();
  }, [isAuthenticated, ensure]);

  useEffect(() => {
    if (!isLoading && loaded && !isAuthenticated && !demo) router.replace("/");
  }, [isLoading, loaded, isAuthenticated, demo, router]);

  const step: StepId = local ?? ((state?.user.step as StepId | null) ?? "you");
  const index = STEPS.findIndex((s) => s.id === step);

  const go = (id: StepId) => {
    setLocal(id);
    void setStepRemote({ step: id });
    window.scrollTo({ top: 0 });
  };
  const next = () => go(STEPS[Math.min(index + 1, STEPS.length - 1)]!.id);
  const back = () => go(STEPS[Math.max(index - 1, 0)]!.id);
  const finish = async () => {
    await complete();
    router.replace("/");
  };

  if (!state) {
    return (
      <div className="mx-auto max-w-xl px-4 pt-6">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="mt-6 h-64 rounded-card" />
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-page">
      <header className="sticky top-0 z-30 border-b border-line bg-white/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-xl items-center gap-3 px-4">
          {index > 0 && step !== "done" ? (
            <button onClick={back} aria-label="Back" className="press -ml-2 grid size-9 place-items-center rounded-full text-navy hover:bg-page">
              <ArrowLeft className="size-5" />
            </button>
          ) : (
            <Wordmark className="text-[18px]" />
          )}
          <div className="flex-1" />
          {step !== "done" && (
            <button onClick={finish} className="text-label font-semibold text-mute hover:text-navy">
              Finish later
            </button>
          )}
        </div>
        <div className="mx-auto flex max-w-xl gap-1 px-4 pb-2">
          {STEPS.slice(0, -1).map((s, i) => (
            <span key={s.id} className={cn("h-1 flex-1 rounded-full transition-colors duration-300", i <= index ? "bg-navy" : "bg-line")} />
          ))}
        </div>
      </header>

      <main className="mx-auto max-w-xl px-4 pt-6 pb-32">
        {step !== "done" && <div className="text-label font-semibold text-cyan-ink">Step {index + 1} of {STEPS.length - 1}</div>}
        <h1 className="mt-1 mb-5 text-[26px] leading-[32px] font-bold tracking-[-0.02em] text-navy [font-stretch:106%]">{STEPS[index]!.title}</h1>
        <div key={step} className="rise">
          {step === "you" && <You state={state} onNext={next} />}
          {step === "goals" && <Goals state={state} onNext={next} />}
          {step === "sources" && <Sources onNext={next} />}
          {step === "history" && <History onNext={next} onBack={() => go("sources")} />}
          {step === "review" && <Review state={state} onNext={next} />}
          {step === "assistant" && <Assistant state={state} onNext={next} />}
          {step === "wallet" && <Wallet state={state} onNext={next} />}
          {step === "chat" && <Chat state={state} onNext={next} />}
          {step === "people" && <People state={state} onNext={next} />}
          {step === "done" && <Done onFinish={finish} />}
        </div>
      </main>
    </div>
  );
}

type State = NonNullable<ReturnType<typeof useQuery<typeof api.onboarding.state>>>;

/** Rendered into <body> so the step's entry animation can't capture its fixed position. */
function Footer({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(
    <div className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-xl gap-2 px-4 pt-3">{children}</div>
    </div>,
    document.body,
  );
}

function Continue({ onClick, disabled, busy, label = "Continue" }: { onClick: () => void; disabled?: boolean; busy?: boolean; label?: string }) {
  return (
    <Button size="lg" className="flex-1" onClick={onClick} disabled={disabled || busy}>
      {busy && <LoaderCircle className="size-4 animate-spin" />}
      {label}
    </Button>
  );
}

function guessCountry(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return COUNTRIES.find((c) => c.timezone === tz)?.code ?? (tz.startsWith("Asia/Calcutta") ? "IN" : "IN");
  } catch {
    return "IN";
  }
}

function timezones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone");
  } catch {
    return COUNTRIES.map((c) => c.timezone);
  }
}

function You({ state, onNext }: { state: State; onNext: () => void }) {
  const save = useMutation(api.onboarding.savePreferences);
  const initialCountry = state.user.timezone ? state.user.country : guessCountry();
  const [form, setForm] = useState({
    name: state.user.name,
    country: initialCountry,
    currency: (state.user.timezone ? state.user.currency : countryInfo(initialCountry).currency) as Currency,
    timezone: state.user.timezone ?? (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        return countryInfo(initialCountry).timezone;
      }
    })(),
    incomeDay: state.user.incomeDay ? String(state.user.incomeDay) : "",
  });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const zones = useMemo(() => [...new Set([form.timezone, ...timezones()])], [form.timezone]);
  return (
    <>
      <div className="card space-y-4 p-4">
        <Field label="What should we call you?">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="First name" autoFocus={!form.name} />
        </Field>
        <Field label="Where do you live?">
          <Select
            value={form.country}
            onChange={(e) => {
              const c = countryInfo(e.target.value);
              setForm({ ...form, country: c.code, currency: c.currency, timezone: c.timezone });
            }}
          >
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Show totals in">
            <Select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value as Currency })}>
              {FIAT_CODES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Field label="Payday">
            <Select value={form.incomeDay} onChange={(e) => setForm({ ...form, incomeDay: e.target.value })}>
              <option value="">Not sure</option>
              {Array.from({ length: 31 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {ordinal(i + 1)} of the month
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Time zone">
          <Select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
            {zones.map((z) => (
              <option key={z}>{z}</option>
            ))}
          </Select>
        </Field>
        <p className="text-label text-mute">Each account keeps its own currency. Totals are converted with daily reference rates.</p>
      </div>
      <ErrorText>{error}</ErrorText>
      <Footer>
        <Continue
          busy={busy}
          disabled={!form.name.trim()}
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              await save({
                name: form.name,
                country: form.country,
                currency: form.currency,
                timezone: form.timezone,
                incomeDay: form.incomeDay ? Number(form.incomeDay) : undefined,
              });
              onNext();
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        />
      </Footer>
    </>
  );
}

function ordinal(n: number) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

function Goals({ state, onNext }: { state: State; onNext: () => void }) {
  const save = useMutation(api.onboarding.savePriorities);
  const [picked, setPicked] = useState<string[]>(state.user.priorities.length ? state.user.priorities : ["spending", "bills"]);
  return (
    <>
      <p className="-mt-3 mb-4 text-body text-ink-2">Pick as many as you like. You can change these later.</p>
      <div className="grid gap-2">
        {PRIORITIES.map((p) => (
          <Choice
            key={p.id}
            selected={picked.includes(p.id)}
            onClick={() => setPicked((x) => (x.includes(p.id) ? x.filter((y) => y !== p.id) : [...x, p.id]))}
            className="h-12"
          >
            {p.label}
          </Choice>
        ))}
      </div>
      <Footer>
        <Continue
          onClick={async () => {
            await save({ priorities: picked });
            onNext();
          }}
        />
      </Footer>
    </>
  );
}

function Sources({ onNext }: { onNext: () => void }) {
  const accounts = useQuery(api.connections.list);
  const [open, setOpen] = useState<SourceKind | null>(null);
  const [sheetKey, setSheetKey] = useState(0);
  return (
    <>
      <p className="-mt-3 mb-4 text-body text-ink-2">Add every account you use. As many as you want, any type. Adding one never lets an agent spend from it.</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {(Object.keys(KIND_META) as SourceKind[]).map((k) => {
          const m = KIND_META[k];
          const count = accounts?.filter((a) => a.kind === k).length ?? 0;
          return (
            <button
              key={k}
              onClick={() => {
                setSheetKey((x) => x + 1);
                setOpen(k);
              }}
              className="press card relative flex flex-col items-start gap-2 p-3 text-left"
            >
              <IconTile icon={m.icon} />
              <span className="text-body font-semibold">{m.label}</span>
              <span className="-mt-1.5 text-label leading-[15px] text-mute">{m.blurb}</span>
              <span className="absolute top-3 right-3">
                {count > 0 ? <Chip tone="green">{count} added</Chip> : <Plus className="size-4 text-mute" />}
              </span>
            </button>
          );
        })}
      </div>

      {accounts && accounts.length > 0 && (
        <div className="card mt-4 px-4 py-1">
          <Divided>
            {accounts.map((a) => (
              <AccountRow key={a._id} account={a as AccountView} />
            ))}
          </Divided>
        </div>
      )}

      {open && <AddSourceSheet key={sheetKey} open={Boolean(open)} onOpenChange={(o) => !o && setOpen(null)} initialKind={open} />}

      <Footer>
        <Continue onClick={onNext} label={accounts && accounts.length > 0 ? "Continue" : "Skip for now"} />
      </Footer>
    </>
  );
}

function History({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const accounts = useQuery(api.connections.list);
  const reconnect = useMutation(api.connections.reconnect);
  const [sheet, setSheet] = useState<{ id: string; mode: HistoryMode } | null>(null);
  const target = accounts?.find((a) => a._id === sheet?.id);
  if (!accounts) return <Skeleton className="h-64 rounded-card" />;
  if (accounts.length === 0) {
    return (
      <div className="card p-5 text-center">
        <p className="text-body text-ink-2">Add an account first, then bring in its history.</p>
        <Button className="mt-4" onClick={onBack}>
          Add an account
        </Button>
      </div>
    );
  }
  const waiting = accounts.some((a) => a.status === "syncing");
  return (
    <>
      <p className="-mt-3 mb-4 text-body text-ink-2">The last 3 months is enough to find your bills and subscriptions. Duplicates across accounts are removed for you.</p>
      <div className="space-y-3">
        {accounts.map((a) => (
          <div key={a._id} className="card p-4">
            <AccountRow account={a as AccountView} />
            {a.status !== "syncing" && a.kind !== "crypto" && (
              <div className="mt-1 grid grid-cols-3 gap-2">
                {a.source === "sandbox" ? (
                  <ActionTile icon={RefreshCw} label="Sync again" onClick={() => reconnect({ accountId: a._id })} />
                ) : (
                  <ActionTile icon={FileSpreadsheet} label="Statement" onClick={() => setSheet({ id: a._id, mode: "statement" })} />
                )}
                <ActionTile icon={Camera} label="Scan" onClick={() => setSheet({ id: a._id, mode: "scan" })} />
                <ActionTile icon={PenLine} label="By hand" onClick={() => setSheet({ id: a._id, mode: "manual" })} />
              </div>
            )}
            {a.kind === "crypto" && a.source === "onchain" && a.status !== "syncing" && (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {a.holdings.slice(0, 6).map((h) => (
                  <Chip key={`${h.chain}-${h.asset}`} tone="neutral">
                    {fmtAmount(h.amount)} {h.asset} · {h.chain}
                  </Chip>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {target && sheet && (
        <HistorySheet open onOpenChange={(o) => !o && setSheet(null)} account={target} mode={sheet.mode} />
      )}
      <Footer>
        <Continue onClick={onNext} label={waiting ? "Syncing, you can continue" : "Continue"} />
      </Footer>
    </>
  );
}

function ActionTile({ icon: Icon, label, onClick }: { icon: typeof Camera; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="press flex h-16 flex-col items-center justify-center gap-1 rounded-[12px] bg-page text-label font-semibold text-navy hover:bg-sky">
      <Icon className="size-5" strokeWidth={1.9} />
      {label}
    </button>
  );
}

function Review({ state, onNext }: { state: State; onNext: () => void }) {
  const home = useQuery(api.home.overview);
  const bills = useQuery(api.money.obligations);
  const review = useMutation(api.money.reviewSuggestion);
  const setBudget = useMutation(api.money.setBudget);
  const cur = state.user.currency;
  const [budget, setBudgetText] = useState(fromMinorUnits(state.user.monthlyBudgetMinor, cur));
  const [emergency, setEmergency] = useState(fromMinorUnits(state.user.emergencyMinor, cur));
  if (!home || !bills) return <Skeleton className="h-80 rounded-card" />;
  const o = home.overview;
  const suggested = bills.filter((b) => b.status === "suggested");
  const kept = bills.filter((b) => b.status === "active");
  return (
    <>
      <section className="overflow-hidden rounded-card bg-navy text-white">
        <div className="grid grid-cols-2 divide-x divide-white/10">
          <div className="min-w-0 p-4">
            <div className="text-label text-white/70">Net worth</div>
            <div className="figure mt-0.5 truncate text-[21px] leading-[28px]">{formatMoney(o.netWorth, cur)}</div>
          </div>
          <div className="min-w-0 p-4">
            <div className="text-label text-white/70">Safe to spend</div>
            <div className="figure mt-0.5 truncate text-[21px] leading-[28px]">{formatMoney(o.available, cur)}</div>
          </div>
        </div>
        <div className="border-t border-white/10 px-4 py-2.5 text-label text-white/70">
          {o.accountCount} accounts{o.cryptoValue ? ` · crypto ${formatMoney(o.cryptoValue, cur)}` : ""} · rates from {o.ratesDate}
        </div>
      </section>

      <div className="card mt-4 p-4">
        <h2 className="text-title font-semibold">{suggested.length ? `We found ${suggested.length} regular payments` : "Regular payments"}</h2>
        <p className="mb-2 text-label text-mute">Keep the real ones. Dismissed items won't come back.</p>
        {suggested.length === 0 && kept.length === 0 && <p className="py-3 text-body text-mute">Nothing yet. Import a few months of history to find them.</p>}
        <Divided>
          {[...suggested, ...kept].map((b) => (
            <div key={b._id} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-body font-medium">{b.name}</div>
                <div className="text-label text-mute">
                  {b.cadence} · {dueLabel(b.nextDueAt)}
                  {b.occurrences ? ` · seen ${b.occurrences}×` : ""}
                </div>
              </div>
              <span className="num text-body font-semibold">{formatMoney(b.amountMinor, b.currency)}</span>
              {b.status === "suggested" ? (
                <div className="flex gap-1">
                  <button onClick={() => review({ id: b._id, keep: false })} className="press h-8 rounded-btn px-2.5 text-label font-semibold text-mute hover:bg-page">
                    No
                  </button>
                  <button onClick={() => review({ id: b._id, keep: true })} className="press h-8 rounded-btn bg-navy px-3 text-label font-semibold text-white">
                    Keep
                  </button>
                </div>
              ) : (
                <Check className="size-4 text-green" />
              )}
            </div>
          ))}
        </Divided>
      </div>

      <div className="card mt-4 space-y-4 p-4">
        <Field label="Monthly spending budget" hint="Optional. One flexible number, no categories needed.">
          <MoneyInput currency={cur} value={budget} onChange={setBudgetText} />
        </Field>
        <Field label="Emergency fund to keep aside" hint="Left out of Safe to spend.">
          <MoneyInput currency={cur} value={emergency} onChange={setEmergency} />
        </Field>
      </div>

      <Footer>
        <Continue
          onClick={async () => {
            await setBudget({
              monthlyBudgetMinor: toMinorUnits(budget || "0", cur) ?? 0,
              emergencyMinor: toMinorUnits(emergency || "0", cur) ?? 0,
            });
            onNext();
          }}
        />
      </Footer>
    </>
  );
}

function Assistant({ state, onNext }: { state: State; onNext: () => void }) {
  const save = useMutation(api.onboarding.saveAssistant);
  const [form, setForm] = useState({
    autonomy: state.user.autonomy,
    reminderChannel: state.user.reminderChannel,
    quietFrom: state.user.quietFrom,
    quietTo: state.user.quietTo,
    reminderLeadDays: state.user.reminderLeadDays,
  });
  const modes = [
    { id: "draft" as const, title: "Draft only", text: "It prepares payments. You send them." },
    { id: "approve" as const, title: "Ask me every time", text: "It can request payments. Each one needs your approval." },
    { id: "limited" as const, title: "Small things on autopilot", text: "It pays within limits you set next. Anything bigger asks you." },
  ];
  return (
    <>
      <div className="grid gap-2">
        {modes.map((m) => (
          <Choice key={m.id} selected={form.autonomy === m.id} onClick={() => setForm({ ...form, autonomy: m.id })}>
            <span>
              <span className="block font-semibold">{m.title}</span>
              <span className="block text-label text-mute">{m.text}</span>
            </span>
          </Choice>
        ))}
      </div>
      <div className="card mt-4 space-y-4 p-4">
        <Field label="Send reminders to">
          <div className="grid grid-cols-3 gap-2">
            {(["app", "telegram", "whatsapp"] as const).map((c) => (
              <Choice key={c} selected={form.reminderChannel === c} onClick={() => setForm({ ...form, reminderChannel: c })}>
                {c === "app" ? "App" : c === "telegram" ? "Telegram" : "WhatsApp"}
              </Choice>
            ))}
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quiet from">
            <Input type="time" value={form.quietFrom} onChange={(e) => setForm({ ...form, quietFrom: e.target.value })} />
          </Field>
          <Field label="Until">
            <Input type="time" value={form.quietTo} onChange={(e) => setForm({ ...form, quietTo: e.target.value })} />
          </Field>
        </div>
        <div>
          <Field label="Remind me about bills">
            <Select value={form.reminderLeadDays} onChange={(e) => setForm({ ...form, reminderLeadDays: Number(e.target.value) })}>
              {[0, 1, 2, 3, 5, 7].map((d) => (
                <option key={d} value={d}>
                  {d === 0 ? "On the day" : `${d} days before`}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>
      <Footer>
        <Continue
          onClick={async () => {
            await save(form);
            onNext();
          }}
        />
      </Footer>
    </>
  );
}

function Wallet({ state, onNext }: { state: State; onNext: () => void }) {
  const setup = useMutation(api.onboarding.setupWallet);
  const fund = useMutation(api.onboarding.addTestFunds);
  const w = state.wallet;
  const [form, setForm] = useState({
    daily: w ? String(w.dailyCeilingMinor / 100) : "20",
    per: w?.perPaymentMinor ? String(w.perPaymentMinor / 100) : "10",
    protect: w ? String(w.protectedMinor / 100) : "50",
  });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <p className="-mt-3 mb-4 text-body text-ink-2">
        The one place agents can actually pay from. It holds test USDC on Base Sepolia. Your bank and card accounts stay read-only.
      </p>
      <div className="card space-y-4 p-4">
        <Field label="All agents together, per day">
          <MoneyInput currency="USD" value={form.daily} onChange={(daily) => setForm({ ...form, daily })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Biggest single payment">
            <MoneyInput currency="USD" value={form.per} onChange={(per) => setForm({ ...form, per })} />
          </Field>
          <Field label="Keep protected">
            <MoneyInput currency="USD" value={form.protect} onChange={(protect) => setForm({ ...form, protect })} />
          </Field>
        </div>
        <p className="text-label text-mute">Anything above these limits waits for your approval.</p>
      </div>

      <div className="card mt-4 divide-y divide-line px-4">
        <div className="flex items-center gap-3 py-3">
          <IconTile icon={ShieldCheck} tone={w ? "green" : "page"} />
          <div className="flex-1">
            <div className="text-body font-semibold">Wallet</div>
            <div className="text-label text-mute">{w ? `${formatMoney(w.balanceMinor, "USDC")} test USDC` : "Created when you continue"}</div>
          </div>
          {w && (
            <Button size="sm" tone="outline" onClick={() => fund().catch((e) => setError(errorMessage(e)))}>
              Add $100 test
            </Button>
          )}
        </div>
        <div className="flex items-center gap-3 py-3">
          <IconTile icon={Fingerprint} tone="page" />
          <div className="flex-1">
            <div className="text-body font-semibold">Payment passkey</div>
            <div className="text-label text-mute">Approves payments over your limits. Set up once signing is connected.</div>
          </div>
          <Chip tone="amber">Next</Chip>
        </div>
      </div>
      <ErrorText>{error}</ErrorText>
      <Footer>
        <Button size="lg" tone="outline" onClick={onNext}>
          Skip
        </Button>
        <Continue
          busy={busy}
          label={w ? "Save and continue" : "Create wallet"}
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              const daily = toMinorUnits(form.daily, "USD") ?? 0;
              const per = toMinorUnits(form.per, "USD") ?? 0;
              const protect = toMinorUnits(form.protect || "0", "USD") ?? 0;
              const token = await setup({ dailyCeilingMinor: daily, perPaymentMinor: per, protectedMinor: protect });
              // A live vault enforces these, so the change goes to the passkey page.
              if (token) return window.location.assign(approvalLink(token));
              if (!w) await fund();
              onNext();
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        />
      </Footer>
    </>
  );
}

function Chat({ state, onNext }: { state: State; onNext: () => void }) {
  const makeCode = useMutation(api.onboarding.chatCode);
  const [code, setCode] = useState(state.chat?.code ?? null);
  const [copied, setCopied] = useState(false);
  const link = state.bot && code ? `https://t.me/${state.bot}?start=${code}` : null;
  return (
    <>
      <p className="-mt-3 mb-4 text-body text-ink-2">The same assistant, records and approvals, in the chat app you already use. Linking always starts here, never from the chat.</p>
      <div className="card p-4">
        <div className="flex items-center gap-3">
          <IconTile icon={Send} />
          <div className="flex-1">
            <div className="text-body font-semibold">Telegram</div>
            <div className="text-label text-mute">{state.chat?.linked ? "Linked" : "Send the code to the bot"}</div>
          </div>
          {state.chat?.linked && <Chip tone="green">Linked</Chip>}
        </div>
        {code ? (
          <div className="mt-4 rounded-[12px] bg-page p-4 text-center">
            <div className="text-label text-mute">Your code</div>
            <div className="num mt-1 text-[32px] leading-[38px] font-bold tracking-[0.18em] text-navy">{code}</div>
            <div className="mt-3 flex justify-center gap-2">
              <Button
                size="sm"
                tone="outline"
                icon={copied ? Check : Copy}
                onClick={() => {
                  void navigator.clipboard?.writeText(code);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1400);
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
              {link && (
                <a href={link} target="_blank" rel="noopener" className="press inline-flex h-8 items-center gap-1.5 rounded-btn bg-navy px-3 text-label font-semibold text-white">
                  Open Telegram
                </a>
              )}
            </div>
            {!link && <p className="mt-3 text-label text-mute">The bot goes live soon. This code will still work.</p>}
          </div>
        ) : (
          <Button className="mt-4 w-full" onClick={async () => setCode(await makeCode({ channel: "telegram" }))}>
            Get a linking code
          </Button>
        )}
      </div>
      <div className="card mt-3 flex items-center gap-3 p-4">
        <IconTile icon={MessageCircle} tone="page" />
        <div className="flex-1">
          <div className="text-body font-semibold">WhatsApp</div>
          <div className="text-label text-mute">After Telegram, once Meta approves the business number</div>
        </div>
        <Chip>Later</Chip>
      </div>
      <Footer>
        <Continue onClick={onNext} />
      </Footer>
    </>
  );
}

const ASSISTANTS = [
  { id: "claude" as const, name: "Claude" },
  { id: "chatgpt" as const, name: "ChatGPT" },
  { id: "openclaw" as const, name: "OpenClaw" },
  { id: "hermes" as const, name: "Hermes" },
  { id: "poke" as const, name: "Poke" },
];

function People({ state, onNext }: { state: State; onNext: () => void }) {
  const add = useMutation(api.onboarding.addAssistant);
  const remove = useMutation(api.onboarding.removeAssistant);
  const invite = useMutation(api.onboarding.inviteFamily);
  const [form, setForm] = useState({ name: "", relation: "", country: state.user.country });
  const [error, setError] = useState<string>();
  return (
    <>
      <div className="card p-4">
        <h2 className="text-title font-semibold">Outside assistants</h2>
        <p className="mb-3 text-label text-mute">Each gets its own access, starting read-only. You choose what each one may do later.</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {ASSISTANTS.map((a) => {
            const found = state.agents.find((x) => x.provider === a.id);
            return (
              <Choice
                key={a.id}
                selected={Boolean(found)}
                onClick={() => (found ? remove({ agentId: found._id as Id<"agents"> }) : add({ provider: a.id }))}
              >
                <AgentMark provider={a.id} size={28} />
                {a.name}
              </Choice>
            );
          })}
        </div>
      </div>

      <div className="card mt-4 p-4">
        <h2 className="text-title font-semibold">Family</h2>
        <p className="mb-3 text-label text-mute">They keep their own accounts. They can ask you for money; nothing moves without your approval.</p>
        {state.family.length > 0 && (
          <Divided className="mb-3">
            {state.family.map((f) => (
              <div key={f._id} className="flex items-center justify-between py-2.5">
                <span className="text-body font-medium">{f.name}</span>
                <span className="text-label text-mute">
                  {f.relation} · {f.status === "invited" ? "Invited" : "Paired"}
                </span>
              </div>
            ))}
          </Divided>
        )}
        <form
          className="grid grid-cols-2 gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(undefined);
            try {
              await invite(form);
              setForm({ ...form, name: "", relation: "" });
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        >
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Name" />
          <Input value={form.relation} onChange={(e) => setForm({ ...form, relation: e.target.value })} placeholder="Relation" />
          <Select value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })}>
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </Select>
          <Button type="submit" tone="outline" icon={UserPlus} disabled={!form.name.trim()}>
            Invite
          </Button>
        </form>
        <ErrorText>{error}</ErrorText>
      </div>
      <Footer>
        <Continue onClick={onNext} />
      </Footer>
    </>
  );
}

function Done({ onFinish }: { onFinish: () => void }) {
  const home = useQuery(api.home.overview);
  const bills = useQuery(api.money.obligations);
  const router = useRouter();
  const complete = useMutation(api.onboarding.complete);
  if (!home || !bills) return <Skeleton className="h-64 rounded-card" />;
  const o = home.overview;
  const subs = bills.filter((b) => b.status === "active" && b.kind === "subscription");
  const monthlySubs = subs.reduce((s, b) => s + (b.cadence === "yearly" ? Math.round(b.amountMinor / 12) : b.amountMinor), 0);
  const nextBill = bills.filter((b) => b.status === "active").sort((a, b) => a.nextDueAt - b.nextDueAt)[0];
  const facts = [
    { label: "Safe to spend", value: formatMoney(o.available, o.currency), sub: `${formatMoney(o.perDay, o.currency)} a day until payday` },
    nextBill && { label: "Next bill", value: nextBill.name, sub: `${formatMoney(nextBill.amountMinor, nextBill.currency)} · ${dueLabel(nextBill.nextDueAt)}` },
    subs.length > 0 && { label: "Subscriptions", value: formatMoney(monthlySubs, o.currency), sub: `${subs.length} a month` },
  ].filter(Boolean) as { label: string; value: string; sub: string }[];
  return (
    <>
      <div className="space-y-3">
        {facts.map((f) => (
          <div key={f.label} className="card p-4">
            <div className="text-label text-mute">{f.label}</div>
            <div className="figure mt-0.5 text-figure">{f.value}</div>
            <div className="text-label text-ink-2">{f.sub}</div>
          </div>
        ))}
      </div>
      <Footer>
        <Button
          size="lg"
          tone="outline"
          icon={Sparkles}
          onClick={async () => {
            await complete();
            router.replace("/assistant");
          }}
        >
          Ask something
        </Button>
        <Continue onClick={onFinish} label="Go to home" />
      </Footer>
    </>
  );
}

