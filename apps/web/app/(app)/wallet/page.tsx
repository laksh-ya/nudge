"use client";

import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, Clock, Copy, Lock, ShieldCheck, Snowflake, Store, User } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatMoney, shortAddress } from "@/lib/format";
import { TaskCard } from "@/components/task-card";
import { Button, Card, Chip, Divided, IconTile, Meter, PageTitle, Row, Skeleton } from "@/components/ui";

export default function WalletPage() {
  const data = useQuery(api.wallet.get);
  const home = useQuery(api.home.overview);
  const tasks = useQuery(api.tasks.list);
  const setFrozen = useMutation(api.wallet.setFrozen).withOptimisticUpdate((store, { frozen }) => {
    const current = store.getQuery(api.wallet.get, {});
    if (current?.wallet) store.setQuery(api.wallet.get, {}, { ...current, wallet: { ...current.wallet, frozen } });
  });
  const [copied, setCopied] = useState(false);
  const setStep = useMutation(api.onboarding.setStep);
  const fund = useMutation(api.onboarding.addTestFunds);
  const router = useRouter();

  if (data && !data.wallet) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <PageTitle>Wallet</PageTitle>
        <Card>
          <h2 className="text-title font-semibold">Set up the agent wallet</h2>
          <p className="mt-1 text-body text-ink-2">The one place agents can pay from, with a daily ceiling and a protected amount you choose.</p>
          <Button className="mt-4" onClick={async () => { await setStep({ step: "wallet" }); router.push("/onboarding"); }}>
            Set up
          </Button>
        </Card>
      </div>
    );
  }
  if (!data?.wallet || !home) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <PageTitle>Wallet</PageTitle>
        <Skeleton className="h-52 rounded-card" />
        <Skeleton className="h-64 rounded-card" />
      </div>
    );
  }
  const { wallet, payees } = data;
  const spendable = Math.max(0, wallet.balanceMinor - wallet.protectedMinor);
  const spentToday = wallet.dailyCeilingMinor - Math.min(wallet.dailyCeilingMinor, home.overview.agentAuthority);
  const walletTasks = (tasks ?? []).filter((t) => t.currency === "USDC").slice(0, 5);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageTitle>Wallet</PageTitle>

      <section className={cn("rise overflow-hidden rounded-card text-white", wallet.frozen ? "bg-[#3b4a66]" : "bg-navy")}>
        <div className="p-5">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-label text-white/70">
              Agent wallet
              <Chip className="bg-white/10 text-cyan">Base Sepolia · test</Chip>
            </span>
            {wallet.frozen && (
              <Chip className="bg-white/15 text-white">
                <Snowflake className="size-3" /> Frozen
              </Chip>
            )}
          </div>
          <div className="figure mt-1 text-hero">{formatMoney(wallet.balanceMinor, "USDC", { cents: true })}</div>
          {wallet.address ? (
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(wallet.address);
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              }}
              className="press mt-2 flex items-center gap-1.5 text-label text-white/70 hover:text-white"
            >
              <span className="num">{shortAddress(wallet.address)}</span>
              {copied ? <Check className="size-3.5 text-cyan" /> : <Copy className="size-3.5" />}
            </button>
          ) : (
            <div className="mt-2 flex items-center gap-2 text-label text-white/70">
              Contract not deployed yet
              <button onClick={() => fund()} className="press rounded-md bg-white/10 px-2 py-0.5 font-semibold text-cyan">
                + $100 test
              </button>
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 border-t border-white/10">
          <div className="border-r border-white/10 px-5 py-3">
            <div className="flex items-center gap-1.5 text-label text-white/60">
              <Lock className="size-3" /> Protected
            </div>
            <div className="num mt-0.5 text-title font-semibold">{formatMoney(wallet.protectedMinor, "USDC")}</div>
          </div>
          <div className="px-5 py-3">
            <div className="text-label text-white/60">Agents can use</div>
            <div className="num mt-0.5 text-title font-semibold">{formatMoney(spendable, "USDC")}</div>
          </div>
        </div>
      </section>

      <Card title="Today's ceiling for all agents">
        <div className="flex items-baseline justify-between">
          <span className="figure text-figure">{formatMoney(home.overview.agentAuthority, "USDC", { cents: true })}</span>
          <span className="num text-label text-mute">left of {formatMoney(wallet.dailyCeilingMinor, "USDC")}</span>
        </div>
        <Meter value={spentToday} max={wallet.dailyCeilingMinor} tone={wallet.frozen ? "red" : "cyan"} className="mt-2" />
        <div className="mt-4">
          <Button
            tone={wallet.frozen ? "primary" : "danger"}
            icon={Snowflake}
            className="w-full"
            onClick={() => setFrozen({ frozen: !wallet.frozen })}
          >
            {wallet.frozen ? "Unfreeze wallet" : "Freeze wallet"}
          </Button>
        </div>
      </Card>

      <Card title="Contacts" pad={false}>
        <Divided className="px-4 pb-1">
          {payees.map((p) => (
            <Row
              key={p._id}
              leading={<IconTile icon={p.kind === "person" ? User : Store} tone={p.trusted ? "sky" : "amber"} />}
              title={p.name}
              sub={<span className="num">{p.handle}</span>}
              trailing={
                p.trusted ? (
                  <ShieldCheck className="size-[18px] text-green" aria-label="Trusted" />
                ) : (
                  <Chip tone="amber">
                    <Clock className="size-3" /> New, on hold
                  </Chip>
                )
              }
            />
          ))}
        </Divided>
      </Card>

      {walletTasks.length > 0 && (
        <Card title="Wallet payments">
          <div className="space-y-2">
            {walletTasks.map((t) => (
              <TaskCard key={t._id} task={t} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
