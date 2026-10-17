"use client";

import { useMutation, useQuery } from "convex/react";
import { isVaultVersion } from "@agent-wallet/domain";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, ChevronRight, Copy, ExternalLink, Lock, Snowflake } from "lucide-react";
import { approvalLink } from "@/lib/config";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatMoney, shortAddress } from "@/lib/format";
import { TaskCard } from "@/components/task-card";
import { Button, Card, Chip, Meter, PageTitle, Skeleton } from "@/components/ui";
import { ContactLimitForm, PasskeyCard, RulesCard, WaitingCard } from "@/components/wallet/vault-cards";
import { ContactsCard } from "@/components/wallet/contacts-card";

export default function WalletPage() {
  const data = useQuery(api.wallet.get);
  const home = useQuery(api.home.overview);
  const tasks = useQuery(api.tasks.list);
  const chain = useQuery(api.vault.status);
  const agents = useQuery(api.agents.list);
  const setFrozen = useMutation(api.wallet.setFrozen).withOptimisticUpdate((store, { frozen }) => {
    const current = store.getQuery(api.wallet.get, {});
    if (current?.wallet && frozen) store.setQuery(api.wallet.get, {}, { ...current, wallet: { ...current.wallet, frozen } });
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
  // A live vault's own numbers, read back from the chain; the simulator's otherwise.
  const v = chain?.wallet && isVaultVersion(chain.wallet.version) ? chain.wallet.vault : null;
  const balance = v ? v.balanceMinor : wallet.balanceMinor;
  const protectedMinor = v ? v.protectedMinor : wallet.protectedMinor;
  const ceiling = v ? v.ceilingMinor : wallet.dailyCeilingMinor;
  // What agents together have spent today against the ceiling: the vault's own count, or the simulator's.
  const spentToday = v ? v.spentMinor : (agents ?? []).reduce((s, a) => s + a.spentTodayMinor, 0);
  const left = Math.max(0, ceiling - spentToday);
  const spendable = v ? v.headroomMinor : Math.max(0, wallet.balanceMinor - wallet.protectedMinor);
  const frozen = v ? v.frozen : wallet.frozen;
  const canSpend = (agents ?? []).some((a) => a.status === "active" && a.scopes.includes("spend"));
  const walletTasks = (tasks ?? []).filter((t) => t.currency === "USDC").slice(0, 5);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageTitle>Wallet</PageTitle>

      <section className={cn("rise overflow-hidden rounded-card text-white", frozen ? "bg-[#3b4a66]" : "bg-navy")}>
        <div className="p-5">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-label text-white/70">
              Agent wallet
              <Chip className="bg-white/15 text-white">Base Sepolia · tUSD, no value</Chip>
            </span>
            {frozen && (
              <Chip className="bg-white/15 text-white">
                <Snowflake className="size-3" /> Frozen
              </Chip>
            )}
          </div>
          <div className="figure mt-1 text-hero">{formatMoney(balance, "USDC", { cents: true })}</div>
          {wallet.address ? (
            <div className="mt-2 flex items-center gap-3 text-label text-white/70">
              <button
                onClick={() => {
                  void navigator.clipboard?.writeText(wallet.address);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1400);
                }}
                className="press flex items-center gap-1.5 hover:text-white"
              >
                <span className="num">{shortAddress(wallet.address)}</span>
                {copied ? <Check className="size-3.5 text-cyan" /> : <Copy className="size-3.5" />}
              </button>
              <a href={`${chain?.wallet?.explorer ?? "https://sepolia.basescan.org"}/address/${wallet.address}`} target="_blank" rel="noopener" className="flex items-center gap-1 font-semibold text-cyan">
                Explorer <ExternalLink className="size-3" />
              </a>
            </div>
          ) : (
            <div className="mt-2 flex items-center gap-2 text-label text-white/70">
              Simulated until you create a passkey
              <button onClick={() => fund()} className="press rounded-md bg-white/10 px-2 py-0.5 font-semibold text-cyan">
                + $100 test
              </button>
            </div>
          )}
        </div>
        {!v && (
          <Link href="/proof" className="press flex items-center justify-between gap-3 border-t border-white/10 px-5 py-2.5 text-label font-semibold text-cyan">
            See a live vault enforce these rules on Base Sepolia <ChevronRight className="size-4 shrink-0" />
          </Link>
        )}
        <div className="grid grid-cols-2 border-t border-white/10">
          <div className="border-r border-white/10 px-5 py-3">
            <div className="flex items-center gap-1.5 text-label text-white/60">
              <Lock className="size-3" /> Protected from agents
            </div>
            <div className="num mt-0.5 text-title font-semibold">{formatMoney(protectedMinor, "USDC")}</div>
          </div>
          <div className="px-5 py-3">
            <div className="text-label text-white/60">{v ? "Agents can move now" : "Agents can use"}</div>
            <div className="num mt-0.5 text-title font-semibold">{formatMoney(spendable, "USDC")}</div>
          </div>
        </div>
      </section>

      {chain && (chain.ready || chain.wallet?.status === "live") && <PasskeyCard chain={chain} />}
      {chain && <WaitingCard chain={chain} />}

      <Card title={v ? "All agents, last 24 hours" : "Left today for all agents"}>
        <div className="flex items-baseline justify-between">
          <span className="figure text-figure">{formatMoney(left, "USDC", { cents: true })}</span>
          <span className="num text-label text-mute">left of {formatMoney(ceiling, "USDC")}</span>
        </div>
        <Meter value={spentToday} max={ceiling} tone={frozen ? "red" : "cyan"} className="mt-2" />
        {agents && !frozen && !canSpend && (
          <p className="mt-2 text-label text-ink-2">
            No agent can pay yet. Give one &quot;Pay within limits&quot; in{" "}
            <Link href="/agents" className="font-semibold text-cyan-ink">
              Agents
            </Link>
            .
          </p>
        )}
        <div className="mt-4">
          <Button
            tone={frozen ? "primary" : "danger"}
            icon={Snowflake}
            className="w-full"
            onClick={async () => {
              const token = await setFrozen({ frozen: !frozen });
              if (token) window.location.assign(approvalLink(token));
            }}
          >
            {frozen ? "Unfreeze wallet" : "Freeze wallet"}
          </Button>
        </div>
      </Card>

      {chain && <RulesCard chain={chain} />}

      <ContactsCard payees={payees} live={chain?.wallet?.status === "live"} contactDelay={v?.contactDelay}>
        {chain && <ContactLimitForm chain={chain} payees={payees} />}
      </ContactsCard>

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
