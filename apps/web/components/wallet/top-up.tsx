"use client";

import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { ArrowDownToLine } from "lucide-react";
import type { Currency } from "@agent-wallet/domain";
import { api, type Id } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { Button, Sheet } from "@/components/ui";
import { ErrorText, Field, MoneyInput, Select, errorMessage } from "@/components/form";

const FUNDING = new Set(["bank", "card", "crypto", "cash"]);

/**
 * Top the Nudge wallet up from a connected source (#116): the one wallet agents and you pay from.
 * Test money throughout; the source's balance goes down, the wallet goes up.
 */
export function TopUpButton({ live, className }: { live: boolean; className?: string }) {
  const accounts = useQuery(api.money.accounts);
  const topUp = useMutation(api.wallet.topUp);
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState<string>("");
  const [amount, setAmount] = useState("50");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const sources = (accounts ?? []).filter((a) => FUNDING.has(a.kind));
  const chosen = sources.find((a) => a._id === accountId) ?? sources[0];
  return (
    <>
      <button
        onClick={() => {
          setError(undefined);
          setDone(undefined);
          setOpen(true);
        }}
        className={className ?? "press rounded-md bg-white/10 px-2 py-0.5 font-semibold text-cyan"}
      >
        Top up
      </button>
      <Sheet open={open} onOpenChange={setOpen} title="Top up the Nudge wallet">
        <div className="space-y-4 pb-4">
          <p className="text-body text-ink-2">
            Move money from one of your sources into the wallet your assistants pay from. Test money only: {live ? "test dollars are minted into your vault on Base Sepolia" : "the wallet is simulated"}.
          </p>
          {accounts === undefined ? null : sources.length === 0 ? (
            <p className="rounded-btn bg-page p-3 text-body text-ink-2">
              Connect a bank account, card or crypto wallet first.{" "}
              <Link href="/money" className="font-semibold text-cyan-ink">
                Add a source
              </Link>
            </p>
          ) : done ? (
            <p className="rounded-btn bg-green-soft p-3 text-body text-green">{done}</p>
          ) : (
            <>
              <Field label="From">
                <Select value={chosen?._id ?? ""} onChange={(e) => setAccountId(e.target.value)}>
                  {sources.map((a) => (
                    <option key={a._id} value={a._id}>
                      {a.name} · {formatMoney(a.balanceMinor, a.currency as Currency)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Amount (up to $500)">
                <MoneyInput currency="USD" value={amount} onChange={setAmount} />
              </Field>
              <ErrorText>{error}</ErrorText>
              <Button
                size="lg"
                className="w-full"
                icon={ArrowDownToLine}
                disabled={busy || !chosen}
                onClick={async () => {
                  setBusy(true);
                  setError(undefined);
                  try {
                    const r = await topUp({ accountId: chosen!._id as Id<"accounts">, amount: Number(amount) });
                    setDone(
                      `Added ${formatMoney(r.amountMinor, "USDC")} to the wallet${r.currency === "USD" || r.currency === "USDC" ? "" : `, ${formatMoney(r.costMinor, r.currency as Currency)} from ${chosen!.name}`}.${live ? " It shows once the vault confirms, in a few seconds." : ""}`,
                    );
                  } catch (e) {
                    setError(errorMessage(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Top up
              </Button>
            </>
          )}
        </div>
      </Sheet>
    </>
  );
}
