"use client";

import Link from "next/link";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { ArrowLeft, Bot, Check, Copy, ExternalLink, Fingerprint, Package, Receipt, ShoppingBag, Store, Tag, TrendingDown, Zap } from "lucide-react";
import { api } from "@/lib/api";
import { approvalLink } from "@/lib/config";
import { useDemo } from "@/lib/demo";
import { formatMoney } from "@/lib/format";
import { Wordmark } from "@/components/brand";
import { Button, Chip, Segmented, Sheet } from "@/components/ui";
import { errorMessage } from "@/components/form";

const SITE = process.env.NEXT_PUBLIC_CONVEX_SITE_URL ?? "https://ceaseless-raven-960.convex.site";
const usd = (n: number) => formatMoney(n, "USDC");
const ago = (at: number) => {
  const s = Math.round((Date.now() - at) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : new Date(at).toLocaleDateString();
};

type Item = NonNullable<ReturnType<typeof useQuery<typeof api.commerce.catalog>>>[number];

/**
 * Nudge Test Shop: a real merchant on Base Sepolia that takes test dollars. People buy with their
 * Nudge wallet; agents buy through x402 (the item URL answers 402 with an offer) or by watching for a
 * price drop. The seller side shows every order with its proof of payment.
 */
export default function ShopPage() {
  const catalog = useQuery(api.commerce.catalog);
  const [tab, setTab] = useState<"shop" | "orders" | "seller">("shop");
  const [open, setOpen] = useState<Item | null>(null);
  return (
    <div className="min-h-dvh bg-[#fbf7f1] text-coal">
      <header className="sticky top-0 z-30 border-b border-black/5 bg-[#fbf7f1]/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4">
          <Link href="/" className="press flex items-center gap-1 text-label font-semibold text-ink-2">
            <ArrowLeft className="size-4" />
          </Link>
          <span className="grid size-9 place-items-center rounded-[12px] bg-coal text-white">
            <Store className="size-5" />
          </span>
          <div className="min-w-0">
            <div className="text-[17px] leading-tight font-black tracking-[-0.03em]">Nudge Test Shop</div>
            <div className="text-[12px] text-mute">Takes test dollars on Base Sepolia · humans and agents welcome</div>
          </div>
          <div className="flex-1" />
          <Segmented
            className="hidden w-[340px] sm:flex"
            options={[
              { value: "shop", label: "Shop" },
              { value: "orders", label: "My orders" },
              { value: "seller", label: "Seller view" },
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>
        <div className="px-4 pb-2 sm:hidden">
          <Segmented options={[{ value: "shop", label: "Shop" }, { value: "orders", label: "My orders" }, { value: "seller", label: "Seller" }]} value={tab} onChange={setTab} />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pt-6 pb-16">
        {tab === "shop" && (
          <>
            <section className="mb-6 grid gap-3 rounded-[28px] bg-coal p-6 text-white sm:grid-cols-[1fr_auto] sm:items-center sm:p-8">
              <div>
                <h1 className="text-[30px] leading-[1.05] font-black tracking-[-0.04em] sm:text-[40px]">
                  A shop your AI can pay. <span className="font-serif font-normal italic">Within your rules.</span>
                </h1>
                <p className="mt-3 max-w-[60ch] text-[15px] text-white/70">
                  Every product here has a real x402 price tag. Buy it yourself with your Nudge wallet, or tell your assistant to buy it, now or when the price
                  drops. Small purchases go through on their own; bigger ones wait for your passkey.
                </p>
              </div>
              <div className="flex flex-wrap gap-2 sm:flex-col">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-[13px] font-semibold"><Zap className="size-3.5" /> x402 checkout</span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-[13px] font-semibold"><TrendingDown className="size-3.5" /> Price-drop buying</span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-[13px] font-semibold"><Fingerprint className="size-3.5" /> Passkey above limits</span>
              </div>
            </section>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
              {(catalog ?? []).map((i) => (
                <button key={i.slug} onClick={() => setOpen(i)} className="press group flex flex-col rounded-[24px] bg-white p-4 text-left shadow-[0_1px_0_rgba(0,0,0,0.04)] hover:shadow-[0_8px_30px_rgba(0,0,0,0.06)]">
                  <div className="grid aspect-square place-items-center rounded-[18px] bg-[#f3eee6] text-[64px] transition-transform group-hover:scale-[1.02]">{i.emoji}</div>
                  <div className="mt-3 text-[12px] font-semibold tracking-wide text-mute uppercase">{i.category}</div>
                  <div className="mt-0.5 line-clamp-2 text-[15px] leading-snug font-bold">{i.name}</div>
                  <div className="mt-auto flex items-baseline gap-2 pt-2">
                    <span className="num text-[18px] font-black">{usd(i.priceMinor)}</span>
                    {i.priceMinor < i.basePriceMinor && <span className="num text-[13px] text-mute line-through">{usd(i.basePriceMinor)}</span>}
                    {i.priceMinor < i.basePriceMinor && <Chip tone="green">Sale</Chip>}
                  </div>
                </button>
              ))}
            </div>
            <p className="mt-6 text-center text-[13px] text-mute">Test shop: prices are in tUSD, test dollars with no value. Nothing is shipped.</p>
          </>
        )}
        {tab === "orders" && <MyOrders />}
        {tab === "seller" && <Seller catalog={catalog ?? []} />}
      </main>
      {open && <ProductSheet item={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ProductSheet({ item, onClose }: { item: Item; onClose: () => void }) {
  const { isAuthenticated } = useConvexAuth();
  const { setDemo } = useDemo();
  const buy = useMutation(api.commerce.buyNow);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string>();
  const [error, setError] = useState<string>();
  const [how, setHow] = useState<"me" | "agent">("me");
  const url = `${SITE}/x402/store/item?slug=${item.slug}`;
  const watchPrice = (Math.max(1, Math.floor(item.basePriceMinor * 0.6)) / 100).toFixed(2);
  const prompts = [
    `Buy "${item.name}" from the Nudge Test Shop: ${url} (pay at most ${(item.priceMinor / 100 + 0.01).toFixed(2)} dollars).`,
    `Watch ${url} and buy "${item.name}" when it's ${watchPrice} dollars or less.`,
  ];
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={item.name}>
      <div className="space-y-4 pb-4">
        <div className="flex items-center gap-4">
          <div className="grid size-24 shrink-0 place-items-center rounded-[18px] bg-[#f3eee6] text-[52px]">{item.emoji}</div>
          <div>
            <div className="flex items-baseline gap-2">
              <span className="num text-[26px] font-black">{usd(item.priceMinor)}</span>
              {item.priceMinor < item.basePriceMinor && <span className="num text-mute line-through">{usd(item.basePriceMinor)}</span>}
            </div>
            <p className="mt-1 text-body text-ink-2">{item.blurb}</p>
          </div>
        </div>
        <Segmented options={[{ value: "me", label: "Buy it myself" }, { value: "agent", label: "Let my agent buy it" }]} value={how} onChange={setHow} />
        {how === "me" ? (
          done ? (
            <p className="rounded-btn bg-green-soft p-3 text-body text-green">{done}</p>
          ) : isAuthenticated ? (
            <>
              <p className="text-label text-mute">
                Paid from your Nudge wallet in test dollars. On an on-chain wallet you approve with your passkey; the vault pays the shop directly and the
                shop checks the transaction before it hands over your order.
              </p>
              {error && <p className="text-label text-red">{error}</p>}
              <Button
                size="lg"
                className="w-full"
                icon={ShoppingBag}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(undefined);
                  try {
                    const r = await buy({ slug: item.slug });
                    if (r.token) return window.location.assign(approvalLink(r.token));
                    setDone("Paid. Your order arrives in My orders in a few seconds.");
                  } catch (e) {
                    setError(errorMessage(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Pay {usd(item.priceMinor)} with Nudge
              </Button>
            </>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Button tone="outline" onClick={() => setDemo(true)}>
                Try with a demo wallet
              </Button>
              <Link href="/sign-in" className="press flex h-11 items-center justify-center rounded-btn bg-navy text-body font-semibold text-white">
                Sign in to buy
              </Link>
            </div>
          )
        ) : (
          <div className="space-y-3">
            <p className="text-body text-ink-2">
              Give your assistant one of these (Claude, Instinct or any assistant connected to Nudge). It uses <b>pay_x402</b> or <b>watch_price</b>: inside its
              limits it just buys; above them you get a passkey link.
            </p>
            {prompts.map((p) => (
              <CopyBox key={p} text={p} />
            ))}
            <details className="rounded-btn border border-line p-3">
              <summary className="cursor-pointer text-label font-semibold text-cyan-ink">For developers: the x402 offer</summary>
              <p className="mt-2 text-label text-ink-2">
                GET <code className="num">{url}</code> answers <b>402 Payment Required</b> with an <code>accepts</code> offer (scheme <code>transfer</code>, network
                base-sepolia, asset tUSD, payTo the shop). Pay it on-chain, then retry with <code>X-PAYMENT</code> carrying the transaction hash.
              </p>
              <a href={url} target="_blank" rel="noopener" className="mt-2 inline-flex items-center gap-1 text-label font-semibold text-cyan-ink">
                Open the 402 response <ExternalLink className="size-3" />
              </a>
            </details>
          </div>
        )}
      </div>
    </Sheet>
  );
}

function CopyBox({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2 rounded-btn bg-page p-3">
      <Bot className="mt-0.5 size-4 shrink-0 text-cyan-ink" />
      <p className="min-w-0 flex-1 text-label break-words text-ink">{text}</p>
      <button
        className="press shrink-0 text-cyan-ink"
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}

function MyOrders() {
  const { isAuthenticated } = useConvexAuth();
  const mine = useQuery(api.commerce.myPurchases);
  const { setDemo } = useDemo();
  if (!isAuthenticated)
    return (
      <div className="mx-auto max-w-md rounded-[24px] bg-white p-6 text-center">
        <Receipt className="mx-auto size-8 text-mute" />
        <p className="mt-2 text-body text-ink-2">Sign in (or open a demo wallet) to see what you and your assistants bought.</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button tone="outline" onClick={() => setDemo(true)}>
            Demo wallet
          </Button>
          <Link href="/sign-in" className="press flex h-11 items-center justify-center rounded-btn bg-navy text-body font-semibold text-white">
            Sign in
          </Link>
        </div>
      </div>
    );
  if (!mine?.length) return <p className="py-16 text-center text-body text-mute">Nothing bought yet. Pick something in the shop, or ask your assistant to.</p>;
  return (
    <div className="mx-auto max-w-3xl space-y-3">
      {mine.map((o) => (
        <div key={o.taskId} className="rounded-[20px] bg-white p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[15px] font-bold">{o.item}</div>
              <div className="text-label text-mute">
                {o.by === "You" ? "You bought it" : `${o.by} bought it`} · {o.merchant ?? "merchant"} · {ago(o.at)}
              </div>
            </div>
            <div className="flex flex-col items-end gap-1">
              <span className="num text-[16px] font-black">{usd(o.amountMinor)}</span>
              <Chip tone={o.state === "confirmed" ? "green" : o.state === "awaiting_approval" ? "amber" : ["failed", "cancelled", "expired"].includes(o.state) ? "red" : "cyan"}>
                {o.state === "confirmed" ? "Delivered" : o.state === "awaiting_approval" ? "Needs your OK" : o.state === "held" ? "On hold" : ["failed", "cancelled", "expired"].includes(o.state) ? "Not bought" : "Paying…"}
              </Chip>
            </div>
          </div>
          {o.approvalToken && (
            <a href={approvalLink(o.approvalToken)} className="press mt-3 flex h-10 items-center justify-center gap-2 rounded-btn bg-navy text-label font-semibold text-white">
              <Fingerprint className="size-4" /> Review and approve
            </a>
          )}
          {o.resource && (
            <div className="mt-3 rounded-btn bg-page p-3">
              <div className="mb-1 flex items-center gap-1.5 text-label font-semibold text-ink-2">
                <Package className="size-3.5" /> What you got
              </div>
              <pre className="num text-[12px] whitespace-pre-wrap text-ink">{prettify(o.resource)}</pre>
            </div>
          )}
          {o.card && (
            <div className="mt-3 rounded-btn bg-coal p-3 text-white">
              <div className="text-label text-white/60">One-time card (test)</div>
              <div className="num mt-1 text-[16px] tracking-[0.12em]">{o.card.number.replace(/(\d{4})/g, "$1 ").trim()}</div>
              <div className="num mt-1 text-label text-white/70">
                {o.card.exp} · CVC {o.card.cvc}
              </div>
            </div>
          )}
          {o.txHash && (
            <a href={`https://sepolia.basescan.org/tx/${o.txHash}`} target="_blank" rel="noopener" className="mt-2 inline-flex items-center gap-1 text-label font-semibold text-cyan-ink">
              Payment on Base Sepolia <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      ))}
    </div>
  );
}

function prettify(resource: string) {
  try {
    const j = JSON.parse(resource) as { content?: string; item?: string };
    return j.content ?? resource;
  } catch {
    return resource;
  }
}

function Seller({ catalog }: { catalog: Item[] }) {
  const orders = useQuery(api.commerce.orders);
  const [busy, setBusy] = useState<string | null>(null);
  const revenue = (orders ?? []).reduce((s, o) => s + o.amountMinor, 0);
  const setPrice = async (slug: string, price?: number) => {
    setBusy(slug);
    try {
      await fetch(`${SITE}/x402/store/price?slug=${slug}${price !== undefined ? `&price=${price}` : ""}`, { method: "POST" });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <section className="rounded-[24px] bg-white p-5">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-[20px] font-black tracking-[-0.03em]">Orders</h2>
            <p className="text-label text-mute">Every order the shop accepted, with its proof of payment. Updates live.</p>
          </div>
          <div className="text-right">
            <div className="text-label text-mute">Last {orders?.length ?? 0} orders</div>
            <div className="num text-[20px] font-black">{usd(revenue)}</div>
          </div>
        </div>
        <div className="mt-4 divide-y divide-line">
          {(orders ?? []).length === 0 && <p className="py-10 text-center text-body text-mute">No orders yet.</p>}
          {(orders ?? []).map((o) => (
            <div key={o._id} className="flex items-center gap-3 py-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-[#f3eee6] text-[22px]">{catalog.find((c) => c.slug === o.slug)?.emoji ?? "📦"}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-body font-semibold">{o.item}</div>
                <div className="truncate text-label text-mute">
                  {o.buyer} · {o.via === "checkout" ? "checkout" : o.via === "watch" ? "price watch (AP2)" : "x402"} · {ago(o.at)}
                </div>
              </div>
              <div className="flex flex-col items-end">
                <span className="num text-body font-bold">{usd(o.amountMinor)}</span>
                {o.tx ? (
                  <a href={`https://sepolia.basescan.org/tx/${o.tx}`} target="_blank" rel="noopener" className="num text-[11px] font-semibold text-cyan-ink">
                    {o.tx.slice(0, 10)}…
                  </a>
                ) : (
                  <span className="text-[11px] text-mute">simulated wallet</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="h-fit rounded-[24px] bg-white p-5">
        <h2 className="flex items-center gap-2 text-[20px] font-black tracking-[-0.03em]">
          <Tag className="size-5" /> Run a sale
        </h2>
        <p className="text-label text-mute">Drop a price to trigger agents watching it. Prices go back to normal after a day.</p>
        <div className="mt-3 divide-y divide-line">
          {catalog.map((i) => (
            <div key={i.slug} className="flex items-center gap-3 py-2.5">
              <span className="text-[22px]">{i.emoji}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-label font-semibold">{i.name}</div>
                <div className="num text-label text-mute">
                  {usd(i.priceMinor)}
                  {i.priceMinor < i.basePriceMinor && ` · was ${usd(i.basePriceMinor)}`}
                </div>
              </div>
              {i.priceMinor < i.basePriceMinor ? (
                <Button size="sm" tone="ghost" disabled={busy === i.slug} onClick={() => setPrice(i.slug)}>
                  End sale
                </Button>
              ) : (
                <Button size="sm" tone="outline" disabled={busy === i.slug} onClick={() => setPrice(i.slug, Math.max(0.01, Math.round(i.basePriceMinor * 0.45) / 100))}>
                  55% off
                </Button>
              )}
            </div>
          ))}
        </div>
        <Wordmark className="mt-4 text-[14px] opacity-50" />
      </section>
    </div>
  );
}
