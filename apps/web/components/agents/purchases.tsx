"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { ShoppingBag, TrendingDown, X } from "lucide-react";
import { api } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { Button, Card, Chip, Divided, Row } from "@/components/ui";
import { errorMessage } from "@/components/form";

const STORE = `${process.env.NEXT_PUBLIC_CONVEX_SITE_URL ?? ""}/x402/store`;

const STATUS: Record<string, { label: string; tone: "green" | "amber" | "neutral" | "red" | "cyan" }> = {
  active: { label: "Watching", tone: "cyan" },
  waiting: { label: "Needs your OK", tone: "amber" },
  bought: { label: "Bought", tone: "green" },
  cancelled: { label: "Stopped", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
};

/**
 * What assistants are buying for you: price watches (AP2 "buy when the price drops") and Nudge's demo
 * x402 store, where you can drop a price to watch an assistant buy within its limits.
 */
export function Purchases() {
  const watches = useQuery(api.commerce.myWatches);
  const bought = useQuery(api.commerce.myPurchases);
  const catalog = useQuery(api.commerce.catalog);
  const cancel = useMutation(api.commerce.ownerCancelWatch);
  const drop = useMutation(api.commerce.dropPrice);
  const [error, setError] = useState<string>();
  const [showStore, setShowStore] = useState(false);
  return (
    <Card title="Purchases" className="mt-4" action={<Chip tone="cyan">x402 · AP2</Chip>}>
      {watches === undefined ? null : watches.length === 0 ? (
        <p className="text-body text-ink-2">
          Ask an assistant to buy something when its price drops ("buy the trail shoes when they're under $6"). It watches the price and buys within its limits;
          above them you get a link to approve.
        </p>
      ) : (
        <Divided>
          {watches.map((w) => (
            <Row
              key={w.watchId}
              leading={<TrendingDown className="size-5 shrink-0 text-cyan-ink" />}
              title={w.item}
              sub={`${w.agent} buys at ${w.buyAtOrBelow} or less${w.lastPrice ? ` · now ${w.lastPrice}` : ""}${w.problem ? ` · ${w.problem}` : ""}`}
              trailing={
                <span className="flex items-center gap-1.5">
                  <Chip tone={STATUS[w.status]?.tone ?? "neutral"}>{STATUS[w.status]?.label ?? w.status}</Chip>
                  {(w.status === "active" || w.status === "waiting") && (
                    <button className="press text-mute" aria-label={`Stop watching ${w.item}`} onClick={() => cancel({ watchId: w.watchId as never })}>
                      <X className="size-4" />
                    </button>
                  )}
                </span>
              }
            />
          ))}
        </Divided>
      )}
      {bought && bought.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-label font-semibold text-mute">Recent purchases</div>
          <Divided>
            {bought.slice(0, 5).map((b) => (
              <Row
                key={b.taskId}
                leading={<ShoppingBag className="size-5 shrink-0 text-cyan-ink" />}
                title={b.item}
                sub={`${b.by} · ${b.kind === "card" ? "one-time card" : b.kind === "watch" ? "bought on a price drop" : "x402"}${b.card ? ` · card ending ${b.card.last4}` : ""}`}
                trailing={
                  <span className="flex items-center gap-1.5">
                    <span className="num text-body font-semibold">{formatMoney(b.amountMinor, "USDC")}</span>
                    <Chip tone={b.state === "confirmed" ? "green" : b.state === "awaiting_approval" ? "amber" : "neutral"}>
                      {b.state === "confirmed" ? "Done" : b.state === "awaiting_approval" ? "Needs you" : b.state.replace("_", " ")}
                    </Chip>
                  </span>
                }
              />
            ))}
          </Divided>
        </div>
      )}
      <a href="/shop" className="press mt-3 flex h-10 items-center justify-center gap-1.5 rounded-btn bg-navy text-label font-semibold text-white">
        <ShoppingBag className="size-4" /> Open the Nudge Test Shop
      </a>
      <button onClick={() => setShowStore((x) => !x)} className="press mt-3 flex items-center gap-1.5 text-label font-semibold text-cyan-ink">
        <ShoppingBag className="size-3.5" /> {showStore ? "Hide" : "Try it with"} the demo x402 store
      </button>
      {showStore && (
        <div className="mt-2 rounded-btn border border-line p-3">
          <p className="text-label text-ink-2">
            A test merchant that charges with HTTP 402 in test dollars. Give an assistant an item URL ("watch {STORE}/item?slug=shoes and buy under $6"), then
            drop the price here.
          </p>
          <Divided className="mt-2">
            {(catalog ?? []).map((i) => (
              <Row
                key={i.slug}
                title={i.name}
                sub={`${STORE}/item?slug=${i.slug}`}
                trailing={
                  <span className="flex items-center gap-2">
                    <span className="num text-body font-semibold">{formatMoney(i.priceMinor, "USDC")}</span>
                    {i.priceMinor === i.basePriceMinor ? (
                      <Button size="sm" tone="outline" onClick={() => drop({ slug: i.slug, priceMinor: Math.max(1, Math.round(i.basePriceMinor * 0.45)) }).catch((e) => setError(errorMessage(e)))}>
                        Drop price
                      </Button>
                    ) : (
                      <Button size="sm" tone="ghost" onClick={() => drop({ slug: i.slug }).catch((e) => setError(errorMessage(e)))}>
                        Reset
                      </Button>
                    )}
                  </span>
                }
              />
            ))}
          </Divided>
          {error && <p className="mt-2 text-label text-red">{error}</p>}
        </div>
      )}
    </Card>
  );
}
