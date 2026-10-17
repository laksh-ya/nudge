"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { Clock, Fingerprint, Plus, ShieldCheck, Store, Trash2, User } from "lucide-react";
import { api, type Id } from "@/lib/api";
import { approvalLink } from "@/lib/config";
import { formatMoney, shortAddress } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { Button, Card, Chip, Divided, Empty, IconTile, Row, Sheet } from "@/components/ui";
import { Choice, ErrorText, Field, Input, errorMessage } from "@/components/form";

export type ContactView = {
  _id: Id<"payees">;
  name: string;
  handle: string;
  kind: "person" | "merchant";
  trusted: boolean;
  holdUntil?: number;
  address?: string;
  onchain?: boolean;
  dailyCapMinor?: number;
  addedAt?: number;
  pendingPasskey?: boolean;
  activeAt?: number;
};

/** "23 h 10 min" for long waits, "4:59" for the last hour. */
export function waitLeft(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function waitLength(seconds: number) {
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 86_400) return `${+(seconds / 3600).toFixed(1)} hours`;
  return `${+(seconds / 86_400).toFixed(1)} days`;
}

/**
 * Who agents may pay. Adding on a live vault needs the passkey and then the vault's waiting period
 * (with a countdown); removing is instant in the app. A simulated wallet adds at once, labelled.
 */
export function ContactsCard({ payees, live, contactDelay, children }: { payees: ContactView[]; live: boolean; contactDelay?: number; children?: React.ReactNode }) {
  const add = useMutation(api.contacts.add);
  const approveAdd = useMutation(api.contacts.approveAdd);
  const remove = useMutation(api.contacts.remove);
  const now = useNow();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", address: "", kind: "person" as "person" | "merchant" });
  const [removing, setRemoving] = useState<ContactView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [rowError, setRowError] = useState<string>();
  const wait = waitLength(contactDelay ?? 86_400);

  async function run(fn: () => Promise<void>, onError: (m: string) => void) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const status = (p: ContactView) => {
    if (p.pendingPasskey) {
      return (
        <Button
          size="sm"
          icon={Fingerprint}
          disabled={busy}
          onClick={() => run(async () => window.location.assign(approvalLink(await approveAdd({ payeeId: p._id }))), setRowError)}
        >
          Approve
        </Button>
      );
    }
    if (p.activeAt && p.activeAt > now) {
      return (
        <Chip tone="amber">
          <Clock className="size-3" /> <span className="num">Active in {waitLeft(p.activeAt - now)}</span>
        </Chip>
      );
    }
    if (!p.trusted) {
      return (
        <Chip tone="amber">
          <Clock className="size-3" /> New, on hold
        </Chip>
      );
    }
    if (p.addedAt && !live) return <Chip>Simulated</Chip>;
    return <ShieldCheck className="size-[18px] text-green" aria-label="Agents can pay this contact" />;
  };

  const sub = (p: ContactView) =>
    [
      p.address ? shortAddress(p.address) : p.handle,
      p.pendingPasskey ? "waiting for your passkey" : p.onchain ? "in vault" : null,
      p.dailyCapMinor ? `agents ${formatMoney(p.dailyCapMinor, "USDC")}/day` : null,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <Card
      title="Contacts"
      pad={false}
      action={
        <Button size="sm" tone="ghost" icon={Plus} className="mr-2" onClick={() => { setError(undefined); setAdding(true); }}>
          Add contact
        </Button>
      }
    >
      {payees.length === 0 ? (
        <Empty>No contacts yet. Agents can only pay people you add here.</Empty>
      ) : (
        <Divided className="px-4 pb-1">
          {payees.map((p) => (
            <Row
              key={p._id}
              leading={<IconTile icon={p.kind === "person" ? User : Store} tone={p.trusted && !p.pendingPasskey ? "sky" : "amber"} />}
              title={p.name}
              sub={<span className="num">{sub(p)}</span>}
              trailing={
                <div className="flex items-center gap-1">
                  {status(p)}
                  <button
                    onClick={() => { setRowError(undefined); setRemoving(p); }}
                    aria-label={`Remove ${p.name}`}
                    className="press grid size-8 place-items-center rounded-full text-mute hover:bg-page hover:text-red"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              }
            />
          ))}
        </Divided>
      )}
      {rowError && <div className="px-4 pb-3"><ErrorText>{rowError}</ErrorText></div>}
      {children}

      <Sheet open={adding} onOpenChange={setAdding} title="Add a contact">
        <form
          className="space-y-4 pb-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(undefined);
            void run(async () => {
              const { token } = await add({ name: form.name, address: form.address, kind: form.kind });
              setForm({ name: "", address: "", kind: "person" });
              if (token) window.location.assign(approvalLink(token));
              else setAdding(false);
            }, setError);
          }}
        >
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Test Shop" maxLength={40} autoComplete="off" />
          </Field>
          <Field label="Wallet address on Base Sepolia" hint="Starts with 0x. Payments go only to this exact address.">
            <Input
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value.trim() })}
              placeholder="0x…"
              className="num"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="Kind of contact">
            <Choice selected={form.kind === "person"} onClick={() => setForm({ ...form, kind: "person" })}>
              <User className="size-4" /> Person
            </Choice>
            <Choice selected={form.kind === "merchant"} onClick={() => setForm({ ...form, kind: "merchant" })}>
              <Store className="size-4" /> Shop or service
            </Choice>
          </div>
          <p className="rounded-btn bg-page p-3 text-label text-ink-2">
            {live
              ? `Your passkey adds it to the vault. Agents can pay it once the vault's ${wait} waiting period for new contacts ends; until then they're refused.`
              : "Simulated wallet: agents can pay it right away. Once the wallet is on-chain, new contacts need your passkey and then the vault's waiting period."}
          </p>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" size="lg" icon={live ? Fingerprint : Plus} className="w-full" disabled={busy || !form.name.trim() || !form.address}>
            {live ? "Add with my passkey" : "Add contact"}
          </Button>
        </form>
      </Sheet>

      <Sheet open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)} title={`Remove ${removing?.name ?? ""}?`}>
        <p className="text-body text-ink-2">
          Agents can&apos;t ask to pay {removing?.name} from now on, and requests waiting for your approval to pay it are cancelled.
          {live && removing?.onchain ? " Then approve with your passkey to take it out of the vault as well." : ""}
        </p>
        <ErrorText>{rowError}</ErrorText>
        <div className="mt-5 mb-4 grid grid-cols-2 gap-2">
          <Button tone="outline" size="lg" onClick={() => setRemoving(null)}>
            Keep
          </Button>
          <Button
            tone="danger"
            size="lg"
            icon={Trash2}
            disabled={busy}
            onClick={() =>
              removing &&
              run(async () => {
                const { token } = await remove({ payeeId: removing._id });
                setRemoving(null);
                if (token) window.location.assign(approvalLink(token));
              }, setRowError)
            }
          >
            Remove
          </Button>
        </div>
      </Sheet>
    </Card>
  );
}
