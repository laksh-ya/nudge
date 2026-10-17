"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { ArrowDown, Clock } from "lucide-react";
import { api } from "@/lib/api";
import { approvalLink } from "@/lib/config";
import { formatMoney } from "@/lib/format";
import { countdown, useNow } from "@/lib/use-now";
import { Initial } from "@/components/brand";
import { Button, ButtonLink, Card, Chip, Divided, Empty, Money, PageTitle, Row, Skeleton } from "@/components/ui";
import { GuardiansCard } from "@/components/family/guardians-card";

const flag: Record<string, string> = { India: "IN", China: "CN", "United Kingdom": "UK" };

export default function FamilyPage() {
  const data = useQuery(api.family.list);
  const respond = useMutation(api.family.respond);
  const now = useNow();
  const [busy, setBusy] = useState<string | null>(null);

  if (!data) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <PageTitle>Family</PageTitle>
        <Skeleton className="h-24 rounded-card" />
        <Skeleton className="h-64 rounded-card" />
      </div>
    );
  }
  const open = data.requests.filter((r) => r.state === "requested");
  const past = data.requests.filter((r) => r.state !== "requested");

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageTitle>Family</PageTitle>

      <p className="rounded-card bg-amber-soft px-4 py-2.5 text-label text-amber">
        Family transfers are simulated in this prototype: no money moves, and quotes are sample data.
      </p>

      {data.members.length === 0 && (
        <Card>
          <Empty>No family yet. Invite family so they can ask you for money; nothing moves without your approval.</Empty>
          <ButtonLink href="/onboarding?step=people" tone="outline" className="w-full">
            Invite family
          </ButtonLink>
        </Card>
      )}

      <div className={data.members.length ? "card rise flex gap-5 overflow-x-auto p-4 [scrollbar-width:none]" : "hidden"}>
        {data.members.map((m) => (
          <div key={m._id} className="flex w-16 shrink-0 flex-col items-center gap-1.5 text-center">
            <div className="relative">
              <Initial name={m.name} size={52} />
              <span className="absolute -right-1 -bottom-0.5 rounded-md bg-white px-1 text-micro font-bold text-navy shadow-[var(--shadow-card)]">
                {flag[m.country] ?? m.country.slice(0, 2)}
              </span>
            </div>
            <span className="w-full truncate text-label font-semibold">{m.name}</span>
            <span className="-mt-1 text-micro text-mute">{m.status === "invited" ? "Invited" : m.relation}</span>
          </div>
        ))}
      </div>

      {open.map((r) => {
        const expired = r.quoteExpiresAt <= now;
        return (
          <Card key={r._id} className="border-l-4 border-cyan">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-title font-semibold">{r.member} asked for {formatMoney(r.receiveMinor, r.receiveCurrency)}</div>
                <div className="text-body text-ink-2">{r.note}</div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Chip tone={expired ? "red" : "amber"}>
                  <Clock className="size-3" />
                  <span className="num">{expired ? "Expired" : countdown(r.quoteExpiresAt, now)}</span>
                </Chip>
                <Chip>Simulated quote</Chip>
              </div>
            </div>
            <div className="mt-4 rounded-[12px] bg-page p-3">
              <div className="flex items-center justify-between">
                <span className="text-label text-mute">You send</span>
                <Money minor={r.sendMinor} currency={r.sendCurrency} className="figure text-title" />
              </div>
              <ArrowDown className="my-1 size-3.5 text-mute" />
              <div className="flex items-center justify-between">
                <span className="text-label text-mute">{r.member} gets</span>
                <Money minor={r.receiveMinor} currency={r.receiveCurrency} className="figure text-title" />
              </div>
              <div className="mt-2 flex justify-between border-t border-line pt-2 text-label text-mute">
                <span>Fee included</span>
                <span className="num">{formatMoney(r.feeMinor, r.sendCurrency)}</span>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <Button tone="outline" disabled={busy === r._id} onClick={() => respond({ requestId: r._id, approve: false })}>
                Decline
              </Button>
              <Button
                disabled={expired || busy === r._id}
                onClick={async () => {
                  setBusy(r._id);
                  const token = await respond({ requestId: r._id, approve: true });
                  if (token) window.location.assign(approvalLink(token));
                  else setBusy(null);
                }}
              >
                Review and pay
              </Button>
            </div>
          </Card>
        );
      })}

      <GuardiansCard />

      <Card title="History" pad={false}>
        <Divided className="px-4 pb-1">
          {past.map((r) => (
            <Row
              key={r._id}
              leading={<Initial name={r.member} size={40} />}
              title={r.note}
              sub={`${r.member} · ${r.state === "received" ? "Received" : r.state === "declined" ? "Declined" : "Approved"}`}
              trailing={
                <div className="flex flex-col items-end">
                  <Money minor={r.sendMinor} currency={r.sendCurrency} className="text-body font-semibold" />
                  <Money minor={r.receiveMinor} currency={r.receiveCurrency} className="text-label text-mute" />
                </div>
              }
            />
          ))}
        </Divided>
      </Card>
    </div>
  );
}
