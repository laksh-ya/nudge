"use client";

import { useMutation, useQuery } from "convex/react";
import { EyeOff, Snowflake } from "lucide-react";
import { api, type Doc } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ago, formatMoney } from "@/lib/format";
import { AgentMark } from "@/components/brand";
import { FreezeAll } from "@/components/shell";
import { Button, Card, Chip, Meter, PageTitle, Skeleton } from "@/components/ui";

const DAY = 86_400_000;

const scopeLabel = { read: "See money", prepare: "Prepare payments", spend: "Spend", request: "Ask for more" };
const providerLabel: Record<string, string> = {
  own: "Telegram",
  claude: "MCP",
  chatgpt: "MCP",
  openclaw: "MCP",
  hermes: "MCP",
  poke: "MCP",
};

export default function AgentsPage() {
  const agents = useQuery(api.agents.list);
  const setStatus = useMutation(api.agents.setStatus).withOptimisticUpdate((store, { agentId, status }) => {
    const current = store.getQuery(api.agents.list, {});
    if (current) store.setQuery(api.agents.list, {}, current.map((a) => (a._id === agentId ? { ...a, status } : a)));
  });

  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle action={<FreezeAll className="h-9 px-3 text-label lg:hidden" />}>Agents</PageTitle>
      {agents === undefined ? (
        <div className="space-y-4">
          <Skeleton className="h-44 rounded-card" />
          <Skeleton className="h-44 rounded-card" />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {agents.map((a) => (
            <AgentCard
              key={a._id}
              agent={a}
              onToggle={() => setStatus({ agentId: a._id, status: a.status === "active" ? "frozen" : "active" })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentCard({ agent: a, onToggle }: { agent: Doc<"agents">; onToggle: () => void }) {
  const frozen = a.status === "frozen";
  const canSpend = a.scopes.includes("spend");
  const daysLeft = Math.max(0, Math.round((a.expiresAt - Date.now()) / DAY));
  return (
    <Card className={cn("flex flex-col", frozen && "bg-[#fbfcfd]")}>
      <div className="flex items-start gap-3">
        <div className={cn(frozen && "opacity-50 grayscale")}>
          <AgentMark provider={a.provider} size={44} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-title font-semibold">{a.name}</span>
            {frozen ? (
              <Chip tone="red">
                <Snowflake className="size-3" /> Frozen
              </Chip>
            ) : (
              <Chip tone="green">Active</Chip>
            )}
          </div>
          <div className="text-label text-mute">
            {providerLabel[a.provider]} · {a.lastUsedAt ? `used ${ago(a.lastUsedAt)}` : "not used yet"}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {a.scopes.map((s) => (
          <Chip key={s} tone={s === "spend" ? "cyan" : "neutral"}>
            {scopeLabel[s]}
          </Chip>
        ))}
        {a.hidesBalances && (
          <Chip>
            <EyeOff className="size-3" /> No balances
          </Chip>
        )}
      </div>

      <div className="mt-4 flex-1">
        {canSpend ? (
          <>
            <div className="flex items-baseline justify-between text-label">
              <span className="text-ink-2">Today</span>
              <span className="num">
                <span className="font-semibold text-ink">{formatMoney(a.spentTodayMinor, "USDC")}</span>
                <span className="text-mute"> of {formatMoney(a.dailyCapMinor, "USDC")}</span>
              </span>
            </div>
            <Meter value={a.spentTodayMinor} max={a.dailyCapMinor} tone={frozen ? "red" : "cyan"} className="mt-1.5" />
            <div className="mt-2 text-label text-mute">
              Up to <span className="num font-semibold text-ink-2">{formatMoney(a.perPaymentMinor, "USDC")}</span> a payment without asking
            </div>
          </>
        ) : (
          <p className="text-label text-mute">Can't spend. Every payment it prepares comes to you.</p>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
        <span className={cn("text-label", daysLeft <= 7 ? "text-amber" : "text-mute")}>
          Access ends in {daysLeft} {daysLeft === 1 ? "day" : "days"}
        </span>
        <Button size="sm" tone={frozen ? "primary" : "danger"} icon={Snowflake} onClick={onToggle}>
          {frozen ? "Unfreeze" : "Freeze"}
        </Button>
      </div>
    </Card>
  );
}
