"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { ArrowDownToLine, Fingerprint, Send } from "lucide-react";
import { api, type Id } from "@/lib/api";
import { approvalLink } from "@/lib/config";
import { formatMoney } from "@/lib/format";
import { Button, Card, Sheet } from "@/components/ui";
import { ErrorText, Field, Input, MoneyInput, Select, errorMessage, toMinorUnits } from "@/components/form";
import type { ContactView } from "./contacts-card";

/**
 * The owner moving money themselves (#11). Each one goes to the approval page, where the passkey
 * signs the exact payment or withdrawal; nothing moves from here.
 */
export function MoveMoneyCard({ payees, payableMinor, withdrawableMinor, changeDelay }: { payees: ContactView[]; payableMinor: number; withdrawableMinor: number; changeDelay: number }) {
  const pay = useMutation(api.owner.pay);
  const withdraw = useMutation(api.owner.withdraw);
  const [open, setOpen] = useState<"pay" | "withdraw" | null>(null);
  const [payeeId, setPayeeId] = useState<Id<"payees"> | "">("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const payable = payees.filter((p) => p.address);
  const minor = toMinorUnits(amount, "USDC");
  const delay = changeDelay < 3600 ? `${Math.max(1, Math.round(changeDelay / 60))} minutes` : `${+(changeDelay / 3600).toFixed(1)} hours`;

  function start(kind: "pay" | "withdraw") {
    setError(undefined);
    setAmount("");
    setNote("");
    setTo("");
    setPayeeId(payable[0]?._id ?? "");
    setOpen(kind);
  }

  async function submit(fn: () => Promise<string>) {
    setBusy(true);
    setError(undefined);
    try {
      window.location.assign(approvalLink(await fn()));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <Card title="Move money">
      <p className="text-label text-ink-2">You pay or withdraw yourself, signed with your passkey. Agents never see these.</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button tone="outline" icon={Send} onClick={() => start("pay")} disabled={payable.length === 0}>
          Pay a contact
        </Button>
        <Button tone="outline" icon={ArrowDownToLine} onClick={() => start("withdraw")} disabled={withdrawableMinor <= 0}>
          Withdraw
        </Button>
      </div>
      {payable.length === 0 && <p className="mt-2 text-label text-mute">Add a contact below to pay someone.</p>}

      <Sheet open={open === "pay"} onOpenChange={(o) => !o && setOpen(null)} title="Pay a contact">
        <form
          className="space-y-4 pb-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!payeeId || minor === null) return;
            void submit(() => pay({ payeeId, amountMinor: minor, note: note || undefined }));
          }}
        >
          <Field label="To">
            <Select value={payeeId} onChange={(e) => setPayeeId(e.target.value as Id<"payees">)}>
              {payable.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.name}
                  {p.onchain ? "" : " (not in vault yet)"}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Amount" hint={`Up to ${formatMoney(payableMinor, "USDC", { cents: true })} without going below your protected amount`}>
            <MoneyInput currency="USDC" value={amount} onChange={setAmount} autoFocus />
          </Field>
          <Field label="What it's for (optional)">
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={140} placeholder="Coffee beans" />
          </Field>
          <p className="rounded-btn bg-page p-3 text-label text-ink-2">
            {payable.find((p) => p._id === payeeId)?.onchain === false
              ? `This contact isn't in your vault yet, so after your passkey the payment waits ${delay} and can be cancelled.`
              : "Your passkey signs this exact payment; the vault sends it to this contact's saved address. Test dollars, no real value."}
          </p>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" size="lg" icon={Fingerprint} className="w-full" disabled={busy || !payeeId || !minor || minor <= 0}>
            Pay with my passkey
          </Button>
        </form>
      </Sheet>

      <Sheet open={open === "withdraw"} onOpenChange={(o) => !o && setOpen(null)} title="Withdraw from the vault">
        <form
          className="space-y-4 pb-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (minor === null) return;
            void submit(() => withdraw({ to, amountMinor: minor }));
          }}
        >
          <Field label="To wallet address on Base Sepolia" hint="Starts with 0x. Double-check it: a withdrawal can't be pulled back once it lands.">
            <Input value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="0x…" className="num" autoComplete="off" autoCapitalize="off" spellCheck={false} />
          </Field>
          <Field label="Amount" hint={`Up to ${formatMoney(withdrawableMinor, "USDC", { cents: true })}, including your protected amount`}>
            <MoneyInput currency="USDC" value={amount} onChange={setAmount} />
          </Field>
          <p className="rounded-btn bg-page p-3 text-label text-ink-2">
            Withdrawing is the only way below your protected amount, so after your passkey the vault waits {delay} before sending it. You can cancel it on this screen until then.
          </p>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" size="lg" icon={Fingerprint} className="w-full" disabled={busy || !to || !minor || minor <= 0}>
            Withdraw with my passkey
          </Button>
        </form>
      </Sheet>
    </Card>
  );
}
