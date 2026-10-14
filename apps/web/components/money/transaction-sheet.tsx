"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { CATEGORIES, formatMoney } from "@agent-wallet/domain";
import { api, type Id } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Button, Chip, Sheet, Skeleton } from "../ui";
import { Choice, Field, Input } from "../form";

export function TransactionSheet({ id, onClose }: { id: Id<"transactions"> | null; onClose: () => void }) {
  const t = useQuery(api.money.transaction, id ? { id } : "skip");
  const recategorize = useMutation(api.money.recategorize);
  const [category, setCategory] = useState("");
  const [always, setAlways] = useState(true);
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState<number | null>(null);

  useEffect(() => {
    if (t) {
      setCategory(t.category);
      setNote(t.note ?? "");
      setSaved(null);
    }
  }, [t?._id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Sheet open={Boolean(id)} onOpenChange={(o) => !o && onClose()} title={t?.merchant ?? "Transaction"}>
      {!t ? (
        <Skeleton className="mb-4 h-60" />
      ) : (
        <div className="space-y-4 pb-4">
          <div>
            <div className={cn("figure text-figure", t.amountMinor > 0 && "text-green")}>{formatMoney(t.amountMinor, t.currency, { sign: true })}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-label text-mute">
              {new Date(t.at).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" })} · {t.account}
              {t.status === "pending" && <Chip tone="amber">Pending</Chip>}
              {t.kind === "transfer" && <Chip tone="cyan">Between your accounts</Chip>}
              {t.duplicateOf && <Chip>Also in {t.duplicateIn}, counted once</Chip>}
            </div>
            {t.raw && t.raw !== t.merchant && <div className="num mt-2 truncate text-label text-mute">{t.raw}</div>}
          </div>
          {t.receiptUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={t.receiptUrl} alt="Receipt" className="max-h-48 rounded-[12px] border border-line object-cover" />
          )}
          <Field label="Category">
            <div className="flex flex-wrap gap-1.5">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c)}
                  className={cn("press h-8 rounded-btn border px-3 text-label font-semibold", category === c ? "border-navy bg-navy text-white" : "border-line text-ink-2")}
                >
                  {c}
                </button>
              ))}
            </div>
          </Field>
          <Choice selected={always} onClick={() => setAlways((a) => !a)}>
            Always use this for {t.merchant}
          </Choice>
          <Field label="Note">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
          </Field>
          {saved !== null && <p className="text-label font-medium text-green">Saved{saved > 0 ? `. ${saved} other ${saved === 1 ? "transaction" : "transactions"} updated too.` : "."}</p>}
          <Button
            size="lg"
            className="w-full"
            onClick={async () => setSaved(await recategorize({ id: t._id, category, always, note: note || undefined }))}
          >
            Save
          </Button>
        </div>
      )}
    </Sheet>
  );
}
