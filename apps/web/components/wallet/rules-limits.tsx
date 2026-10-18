"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Clock, Fingerprint, Hourglass, PiggyBank, ShieldCheck, SlidersHorizontal, UserPlus, Wallet } from "lucide-react";
import { api } from "@/lib/api";
import { approvalLink } from "@/lib/config";
import { formatMoney } from "@/lib/format";
import { Button, Card, Sheet } from "@/components/ui";
import { ErrorText, Field, MoneyInput, Select, errorMessage, toMinorUnits } from "@/components/form";

const usd = (n: number) => formatMoney(n, "USDC");
const dur = (s: number) => (s === 0 ? "no wait" : s < 3600 ? `${Math.round(s / 60)} min` : s < 86_400 ? `${+(s / 3600).toFixed(1)} h` : `${+(s / 86_400).toFixed(1)} days`);

const HOLDS = [0, 120, 600, 1800, 3600, 6 * 3600];
const CONTACT = [0, 600, 3600, 6 * 3600, 86_400, 3 * 86_400];
const CHANGE = [120, 600, 3600, 6 * 3600, 86_400];

type Rules = NonNullable<ReturnType<typeof useQuery<typeof api.wallet.rules>>>;

/** Every rule the wallet enforces, readable at a glance and editable in one place. */
export function RulesLimitsCard() {
  const r = useQuery(api.wallet.rules);
  const [editing, setEditing] = useState(false);
  if (!r) return null;
  const rows = [
    { icon: Wallet, label: "All agents together, per day", value: usd(r.dailyCeilingMinor) },
    { icon: SlidersHorizontal, label: "Biggest single agent payment", value: usd(r.perPaymentMinor) },
    { icon: PiggyBank, label: "Kept safe from agents", value: usd(r.protectedMinor) },
    { icon: Hourglass, label: "Agent payments held", value: r.holdFor ? `above ${usd(r.holdAboveMinor)}, for ${dur(r.holdFor)}` : "never" },
    { icon: UserPlus, label: "New contacts: agents can pay them after", value: dur(r.contactDelay) },
    { icon: Clock, label: "Loosening a rule waits", value: dur(r.changeDelay) },
  ];
  return (
    <Card
      title="Rules and limits"
      action={
        <Button size="sm" tone="outline" icon={SlidersHorizontal} onClick={() => setEditing(true)}>
          Change
        </Button>
      }
    >
      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {rows.map((x) => (
          <div key={x.label} className="flex items-start gap-2.5">
            <x.icon className="mt-0.5 size-4 shrink-0 text-cyan-ink" />
            <div>
              <div className="text-label text-mute">{x.label}</div>
              <div className="text-body font-semibold">{x.value}</div>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 flex items-start gap-1.5 text-label text-mute">
        {r.live && <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />}
        <span>
          {r.live
            ? "Enforced by your vault on Base Sepolia. Changes need your passkey; tightening applies once signed, loosening waits the delay above."
            : "Simulated wallet: changes apply at once. Each agent's own limits are on the Agents screen."}
          {r.pending && " A change is waiting for your passkey."}
        </span>
      </p>
      {editing && <RulesSheet r={r} onClose={() => setEditing(false)} />}
    </Card>
  );
}

function RulesSheet({ r, onClose }: { r: Rules; onClose: () => void }) {
  const save = useMutation(api.wallet.setRules);
  const [f, setF] = useState({
    daily: String(r.dailyCeilingMinor / 100),
    per: String(r.perPaymentMinor / 100),
    protect: String(r.protectedMinor / 100),
    holdAbove: String(r.holdAboveMinor / 100),
    holdFor: String(r.holdFor),
    contact: String(r.contactDelay),
    change: String(r.changeDelay),
  });
  const [error, setError] = useState<string>();
  const opts = (list: number[], cur: number) => [...new Set([...list, cur])].sort((a, b) => a - b);
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title="Rules and limits">
      <div className="space-y-4 pb-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="All agents, per day">
            <MoneyInput currency="USD" value={f.daily} onChange={(daily) => setF({ ...f, daily })} />
          </Field>
          <Field label="Biggest single payment">
            <MoneyInput currency="USD" value={f.per} onChange={(per) => setF({ ...f, per })} />
          </Field>
        </div>
        <Field label="Keep safe from agents" hint="Agents can never spend below this. Your own payments can.">
          <MoneyInput currency="USD" value={f.protect} onChange={(protect) => setF({ ...f, protect })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Hold agent payments above">
            <MoneyInput currency="USD" value={f.holdAbove} onChange={(holdAbove) => setF({ ...f, holdAbove })} />
          </Field>
          <Field label="For">
            <Select value={f.holdFor} onChange={(e) => setF({ ...f, holdFor: e.target.value })}>
              {opts(HOLDS, r.holdFor).map((s) => (
                <option key={s} value={s}>
                  {s === 0 ? "Don't hold" : dur(s)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <p className="-mt-2 text-label text-mute">A held payment waits so you (or your guardian) can stop it before it leaves.</p>
        <Field label="New contacts: agents can pay them after" hint="You can always pay a new contact yourself with your passkey.">
          <Select value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })}>
            {opts(CONTACT, r.contactDelay).map((s) => (
              <option key={s} value={s}>
                {s === 0 ? "Right away" : dur(s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Loosening a rule waits" hint="A stolen session can't quietly raise a limit: you get this long to cancel.">
          <Select value={f.change} onChange={(e) => setF({ ...f, change: e.target.value })}>
            {opts(CHANGE, r.changeDelay).map((s) => (
              <option key={s} value={s}>
                {dur(s)}
              </option>
            ))}
          </Select>
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button
          size="lg"
          className="w-full"
          icon={r.live ? Fingerprint : undefined}
          onClick={async () => {
            setError(undefined);
            try {
              const token = await save({
                dailyCeilingMinor: toMinorUnits(f.daily || "0", "USD") ?? 0,
                perPaymentMinor: toMinorUnits(f.per || "0", "USD") ?? 0,
                protectedMinor: toMinorUnits(f.protect || "0", "USD") ?? 0,
                holdAboveMinor: toMinorUnits(f.holdAbove || "0", "USD") ?? 0,
                holdFor: Number(f.holdFor),
                contactDelay: Number(f.contact),
                changeDelay: Number(f.change),
              });
              if (token) return window.location.assign(approvalLink(token));
              onClose();
            } catch (e) {
              setError(errorMessage(e));
            }
          }}
        >
          {r.live ? "Save and approve with passkey" : "Save"}
        </Button>
      </div>
    </Sheet>
  );
}
