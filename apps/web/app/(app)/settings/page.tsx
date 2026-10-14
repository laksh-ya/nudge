"use client";

import { useClerk } from "@clerk/nextjs";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  Bell,
  Bot,
  Fingerprint,
  Globe,
  Landmark,
  ListRestart,
  LogOut,
  PiggyBank,
  RotateCcw,
  Send,
  Trash2,
  User,
} from "lucide-react";
import { COUNTRIES, FIAT_CODES, country as countryInfo, formatMoney, type Currency } from "@agent-wallet/domain";
import { api } from "@/lib/api";
import { useDemo } from "@/lib/demo";
import { Initial } from "@/components/brand";
import { Choice, ErrorText, Field, Input, MoneyInput, Select, errorMessage, fromMinorUnits, toMinorUnits } from "@/components/form";
import { Button, Card, Chip, Divided, IconTile, PageTitle, Row, Sheet, Skeleton } from "@/components/ui";

type Editing = "profile" | "money" | "assistant" | "fresh" | null;

const MODE_LABEL = { draft: "Draft only", approve: "Ask every time", limited: "Small things on autopilot" };

export default function SettingsPage() {
  const state = useQuery(api.onboarding.state);
  const me = useQuery(api.users.me);
  const { isAuthenticated } = useConvexAuth();
  const { signOut, openUserProfile } = useClerk();
  const { setDemo } = useDemo();
  const restart = useMutation(api.onboarding.restart);
  const restore = useMutation(api.demo.restore);
  const router = useRouter();
  const [editing, setEditing] = useState<Editing>(null);
  const [restored, setRestored] = useState(false);

  if (!state || !me) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <PageTitle>Settings</PageTitle>
        <Skeleton className="h-24 rounded-card" />
        <Skeleton className="h-48 rounded-card" />
      </div>
    );
  }
  const u = state.user;
  const cur = u.currency as Currency;
  const c = countryInfo(u.country);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageTitle>Settings</PageTitle>
      <Card>
        <div className="flex items-center gap-3">
          <Initial name={u.name || " "} size={52} />
          <div className="min-w-0 flex-1">
            <div className="text-title font-semibold">{u.name}</div>
            <div className="truncate text-label text-mute">{me.demo ? "Demo account" : me.email}</div>
          </div>
          {isAuthenticated && (
            <Button tone="outline" size="sm" onClick={() => openUserProfile()}>
              Sign-in details
            </Button>
          )}
        </div>
      </Card>

      <Card title="Profile" pad={false}>
        <Divided className="px-4 pb-1">
          <Row onClick={() => setEditing("profile")} leading={<IconTile icon={Globe} tone="page" />} title="Country and currency" trailing={<span className="text-body text-ink-2">{c.name} · {u.currency}</span>} />
          <Row onClick={() => setEditing("profile")} leading={<IconTile icon={User} tone="page" />} title="Time zone and payday" trailing={<span className="text-body text-ink-2">{u.timezone ?? c.timezone}{u.incomeDay ? ` · ${u.incomeDay}` : ""}</span>} />
        </Divided>
      </Card>

      <Card title="Money" pad={false}>
        <Divided className="px-4 pb-1">
          <Row onClick={() => setEditing("money")} leading={<IconTile icon={PiggyBank} tone="page" />} title="Monthly budget" trailing={<span className="num text-body text-ink-2">{u.monthlyBudgetMinor ? formatMoney(u.monthlyBudgetMinor, cur) : "Not set"}</span>} />
          <Row onClick={() => setEditing("money")} leading={<IconTile icon={PiggyBank} tone="page" />} title="Emergency fund" trailing={<span className="num text-body text-ink-2">{u.emergencyMinor ? formatMoney(u.emergencyMinor, cur) : "Not set"}</span>} />
          <Row href="/money?tab=accounts" leading={<IconTile icon={Landmark} tone="page" />} title="Accounts" trailing={<span className="text-body text-ink-2">{state.counts.accounts}</span>} />
        </Divided>
      </Card>

      <Card title="Assistant" pad={false}>
        <Divided className="px-4 pb-1">
          <Row onClick={() => setEditing("assistant")} leading={<IconTile icon={Bot} tone="page" />} title="What it may do" trailing={<span className="text-body text-ink-2">{MODE_LABEL[u.autonomy]}</span>} />
          <Row onClick={() => setEditing("assistant")} leading={<IconTile icon={Bell} tone="page" />} title="Reminders" trailing={<span className="text-body text-ink-2">{u.reminderChannel === "app" ? "App" : u.reminderChannel} · quiet {u.quietFrom}–{u.quietTo}</span>} />
          <Row href="/agents" leading={<IconTile icon={Bot} tone="page" />} title="Connected assistants" trailing={<span className="text-body text-ink-2">{state.agents.length}</span>} />
        </Divided>
      </Card>

      <Card title="Security" pad={false}>
        <Divided className="px-4 pb-1">
          <Row leading={<IconTile icon={Fingerprint} tone="page" />} title="Payment passkey" sub="Approves payments over your limits" trailing={<Chip tone="amber">Not set up</Chip>} />
          <Row
            href="/onboarding"
            leading={<IconTile icon={Send} tone="page" />}
            title="Telegram"
            sub={state.chat ? `Code ${state.chat.code}` : "Chat with your assistant"}
            trailing={<Chip tone={state.chat?.linked ? "green" : "neutral"}>{state.chat?.linked ? "Linked" : "Not linked"}</Chip>}
          />
        </Divided>
      </Card>

      <Card title="Setup and data" pad={false}>
        <Divided className="px-4 pb-1">
          <Row
            onClick={async () => {
              await restart({ fresh: false });
              router.push("/onboarding");
            }}
            leading={<IconTile icon={ListRestart} tone="page" />}
            title="Go through setup again"
            sub="Keeps your accounts and history"
          />
          {me.demo && (
            <Row
              onClick={async () => {
                await restore();
                setRestored(true);
              }}
              leading={<IconTile icon={RotateCcw} tone="page" />}
              title="Restore demo data"
              sub={restored ? "Restored" : "Puts the sample account back"}
            />
          )}
          <Row onClick={() => setEditing("fresh")} leading={<IconTile icon={Trash2} tone="red" />} title={me.demo ? "Try setup from an empty account" : "Delete my data and start over"} />
        </Divided>
      </Card>

      <Button
        tone="outline"
        size="lg"
        icon={LogOut}
        className="w-full"
        onClick={() => (isAuthenticated ? signOut({ redirectUrl: "/" }) : setDemo(false))}
      >
        {isAuthenticated ? "Sign out" : "Leave demo"}
      </Button>

      {editing === "profile" && <ProfileSheet state={state} onClose={() => setEditing(null)} />}
      {editing === "money" && <MoneySheet state={state} onClose={() => setEditing(null)} />}
      {editing === "assistant" && <AssistantSheet state={state} onClose={() => setEditing(null)} />}
      <Sheet open={editing === "fresh"} onOpenChange={(o) => !o && setEditing(null)} title={me.demo ? "Start the demo empty?" : "Delete everything?"}>
        <p className="text-body text-ink-2">
          {me.demo
            ? "Clears the demo account so you can try setup from the first step. Restore the sample data from Settings any time."
            : "Your accounts, history, bills, goals and assistant settings are deleted. Your sign-in stays."}
        </p>
        <div className="mt-5 mb-2 grid grid-cols-2 gap-2">
          <Button tone="outline" size="lg" onClick={() => setEditing(null)}>
            Cancel
          </Button>
          <Button
            tone="danger"
            size="lg"
            onClick={async () => {
              await restart({ fresh: true });
              router.push("/onboarding");
            }}
          >
            {me.demo ? "Clear and start" : "Delete"}
          </Button>
        </div>
      </Sheet>
      <p className="pt-2 text-center text-label text-mute">
        <Link href="/activity" className="font-semibold text-cyan-ink">
          Activity log
        </Link>
      </p>
    </div>
  );
}

type State = NonNullable<ReturnType<typeof useQuery<typeof api.onboarding.state>>>;

function ProfileSheet({ state, onClose }: { state: State; onClose: () => void }) {
  const save = useMutation(api.onboarding.savePreferences);
  const u = state.user;
  const [form, setForm] = useState({
    name: u.name,
    country: u.country,
    currency: u.currency as Currency,
    timezone: u.timezone ?? countryInfo(u.country).timezone,
    incomeDay: u.incomeDay ? String(u.incomeDay) : "",
  });
  const [error, setError] = useState<string>();
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title="Profile">
      <form
        className="space-y-3 pb-4"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await save({ ...form, incomeDay: form.incomeDay ? Number(form.incomeDay) : undefined });
            onClose();
          } catch (err) {
            setError(errorMessage(err));
          }
        }}
      >
        <Field label="Name">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Country">
            <Select value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })}>
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Show totals in">
            <Select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value as Currency })}>
              {FIAT_CODES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Time zone">
            <Input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
          </Field>
          <Field label="Payday">
            <Select value={form.incomeDay} onChange={(e) => setForm({ ...form, incomeDay: e.target.value })}>
              <option value="">Not sure</option>
              {Array.from({ length: 31 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  Day {i + 1}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <ErrorText>{error}</ErrorText>
        <Button type="submit" size="lg" className="w-full">
          Save
        </Button>
      </form>
    </Sheet>
  );
}

function MoneySheet({ state, onClose }: { state: State; onClose: () => void }) {
  const setBudget = useMutation(api.money.setBudget);
  const cur = state.user.currency as Currency;
  const [budget, setB] = useState(fromMinorUnits(state.user.monthlyBudgetMinor, cur));
  const [emergency, setE] = useState(fromMinorUnits(state.user.emergencyMinor, cur));
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title="Budget">
      <form
        className="space-y-3 pb-4"
        onSubmit={async (e) => {
          e.preventDefault();
          await setBudget({ monthlyBudgetMinor: toMinorUnits(budget || "0", cur) ?? 0, emergencyMinor: toMinorUnits(emergency || "0", cur) ?? 0 });
          onClose();
        }}
      >
        <Field label="Monthly spending budget">
          <MoneyInput currency={cur} value={budget} onChange={setB} />
        </Field>
        <Field label="Emergency fund" hint="Left out of Safe to spend. Agents can never touch it.">
          <MoneyInput currency={cur} value={emergency} onChange={setE} />
        </Field>
        <Button type="submit" size="lg" className="w-full">
          Save
        </Button>
      </form>
    </Sheet>
  );
}

function AssistantSheet({ state, onClose }: { state: State; onClose: () => void }) {
  const save = useMutation(api.onboarding.saveAssistant);
  const u = state.user;
  const [form, setForm] = useState({
    autonomy: u.autonomy,
    reminderChannel: u.reminderChannel,
    quietFrom: u.quietFrom,
    quietTo: u.quietTo,
    reminderLeadDays: u.reminderLeadDays,
  });
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title="Assistant">
      <div className="space-y-3 pb-4">
        {(["draft", "approve", "limited"] as const).map((m) => (
          <Choice key={m} selected={form.autonomy === m} onClick={() => setForm({ ...form, autonomy: m })} className="w-full">
            {MODE_LABEL[m]}
          </Choice>
        ))}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quiet from">
            <Input type="time" value={form.quietFrom} onChange={(e) => setForm({ ...form, quietFrom: e.target.value })} />
          </Field>
          <Field label="Until">
            <Input type="time" value={form.quietTo} onChange={(e) => setForm({ ...form, quietTo: e.target.value })} />
          </Field>
        </div>
        <Field label="Reminders to">
          <Select value={form.reminderChannel} onChange={(e) => setForm({ ...form, reminderChannel: e.target.value as typeof form.reminderChannel })}>
            <option value="app">App</option>
            <option value="telegram">Telegram</option>
            <option value="whatsapp">WhatsApp</option>
          </Select>
        </Field>
        <Button
          size="lg"
          className="w-full"
          onClick={async () => {
            await save(form);
            onClose();
          }}
        >
          Save
        </Button>
      </div>
    </Sheet>
  );
}
