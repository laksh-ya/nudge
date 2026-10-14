"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { EyeOff, KeyRound, Plus, SlidersHorizontal, Snowflake } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ago, formatMoney } from "@/lib/format";
import { AgentMark } from "@/components/brand";
import { FreezeAll } from "@/components/shell";
import { ConnectSheet, PermissionsSheet, type AgentView } from "@/components/agents/agent-sheets";
import { Button, Card, Chip, Meter, PageTitle, Sheet, Skeleton } from "@/components/ui";

const DAY = 86_400_000;

const scopeLabel = { read: "See money", prepare: "Prepare payments", spend: "Pay within limits", request: "Ask for more" };
const PROVIDERS = [
  { id: "claude" as const, name: "Claude" },
  { id: "chatgpt" as const, name: "ChatGPT" },
  { id: "openclaw" as const, name: "OpenClaw" },
  { id: "hermes" as const, name: "Hermes" },
  { id: "poke" as const, name: "Poke" },
];

export default function AgentsPage() {
  const agents = useQuery(api.agents.list);
  const add = useMutation(api.onboarding.addAssistant);
  const setStatus = useMutation(api.agents.setStatus).withOptimisticUpdate((store, { agentId, status }) => {
    const current = store.getQuery(api.agents.list, {});
    if (current) store.setQuery(api.agents.list, {}, current.map((a) => (a._id === agentId ? { ...a, status } : a)));
  });
  const [sheet, setSheet] = useState<{ id: string; kind: "connect" | "permissions" } | null>(null);
  const [adding, setAdding] = useState(false);
  const target = agents?.find((a) => a._id === sheet?.id);
  const missing = PROVIDERS.filter((p) => !agents?.some((a) => a.provider === p.id));

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
              onConnect={() => setSheet({ id: a._id, kind: "connect" })}
              onPermissions={() => setSheet({ id: a._id, kind: "permissions" })}
            />
          ))}
          {missing.length > 0 && (
            <button
              onClick={() => setAdding(true)}
              className="press card flex min-h-[200px] flex-col items-center justify-center gap-2 border-2 border-dashed border-line text-navy hover:border-cyan"
            >
              <Plus className="size-6" />
              <span className="text-body font-semibold">Connect an assistant</span>
              <span className="text-label text-mute">Claude, ChatGPT, OpenClaw and others, over MCP</span>
            </button>
          )}
        </div>
      )}
      {target && sheet?.kind === "connect" && <ConnectSheet agent={target} onClose={() => setSheet(null)} />}
      {target && sheet?.kind === "permissions" && <PermissionsSheet agent={target} onClose={() => setSheet(null)} />}
      <Sheet open={adding} onOpenChange={setAdding} title="Connect an assistant">
        <div className="grid grid-cols-2 gap-2 pb-4">
          {missing.map((p) => (
            <button
              key={p.id}
              onClick={async () => {
                const id = await add({ provider: p.id });
                setAdding(false);
                setSheet({ id, kind: "connect" });
              }}
              className="press flex items-center gap-3 rounded-[14px] border border-line p-3 text-left hover:border-[#cfd8e3]"
            >
              <AgentMark provider={p.id} size={36} />
              <span className="text-body font-semibold">{p.name}</span>
            </button>
          ))}
        </div>
      </Sheet>
    </div>
  );
}

function AgentCard({
  agent: a,
  onToggle,
  onConnect,
  onPermissions,
}: {
  agent: AgentView;
  onToggle: () => void;
  onConnect: () => void;
  onPermissions: () => void;
}) {
  const frozen = a.status === "frozen";
  const pending = a.status === "pending" || (a.provider !== "own" && !a.hasKey);
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
            ) : pending ? (
              <Chip tone="amber">Not connected</Chip>
            ) : (
              <Chip tone="green">Active</Chip>
            )}
          </div>
          <div className="text-label text-mute">
            {a.provider === "own" ? "App and Telegram" : "MCP"} · {a.lastUsedAt ? `used ${ago(a.lastUsedAt)}` : "not used yet"}
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
          <p className="text-label text-mute">Can't spend. Anything it prepares comes to you.</p>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-line pt-3">
        <span className={cn("text-label", daysLeft <= 7 ? "text-amber" : "text-mute")}>
          {daysLeft} {daysLeft === 1 ? "day" : "days"} left
        </span>
        <div className="flex gap-1.5">
          <Button size="sm" tone="ghost" icon={SlidersHorizontal} onClick={onPermissions} aria-label="Permissions">
            Limits
          </Button>
          {a.provider !== "own" && (
            <Button size="sm" tone={pending ? "primary" : "ghost"} icon={KeyRound} onClick={onConnect}>
              {pending ? "Connect" : "Key"}
            </Button>
          )}
          {!pending && (
            <Button size="sm" tone={frozen ? "primary" : "danger"} icon={Snowflake} onClick={onToggle}>
              {frozen ? "Unfreeze" : "Freeze"}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
