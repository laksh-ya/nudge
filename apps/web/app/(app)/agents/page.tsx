"use client";

import { useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";
import { BookOpen, Clock, EyeOff, KeyRound, Plus, SlidersHorizontal, Snowflake } from "lucide-react";
import { api } from "@/lib/api";
import { approvalLink } from "@/lib/config";
import { cn } from "@/lib/cn";
import { ago, formatMoney } from "@/lib/format";
import { AgentMark } from "@/components/brand";
import { FreezeAll } from "@/components/shell";
import { ConnectSheet, PermissionsSheet, type AgentView } from "@/components/agents/agent-sheets";
import { Button, Card, Chip, Meter, PageTitle, Sheet, Skeleton } from "@/components/ui";
import { errorMessage } from "@/components/form";

const DAY = 86_400_000;

const scopeLabel = { read: "See money", prepare: "Prepare payments", spend: "Pay within limits", request: "Ask for more" };
/** Clients that take a bearer key in a header: these connect today. */
const PROVIDERS = [
  { id: "claude" as const, label: "Claude Code", hint: "Terminal command" },
  { id: "other" as const, name: "Cursor", label: "Cursor", hint: "mcp.json" },
  { id: "hermes" as const, label: "Hermes", hint: "config.yaml" },
  { id: "openclaw" as const, label: "OpenClaw", hint: "openclaw.json" },
  { id: "poke" as const, label: "Poke", hint: "URL and key" },
];

/** Connectors that sign in with OAuth only. Shown honestly until MCP OAuth ships (#14). */
const OAUTH_ONLY = [
  { id: "chatgpt", label: "ChatGPT" },
  { id: "claude", label: "claude.ai" },
  { id: "claude", label: "Claude Desktop" },
];

export default function AgentsPage() {
  const agents = useQuery(api.agents.list);
  const add = useMutation(api.onboarding.addAssistant);
  const setStatus = useMutation(api.agents.setStatus).withOptimisticUpdate((store, { agentId, status }) => {
    const current = store.getQuery(api.agents.list, {});
    if (current && status === "frozen") store.setQuery(api.agents.list, {}, current.map((a) => (a._id === agentId ? { ...a, status } : a)));
  });
  const [sheet, setSheet] = useState<{ id: string; kind: "connect" | "permissions" } | null>(null);
  const [adding, setAdding] = useState(false);
  const [otherName, setOtherName] = useState("");
  const [addError, setAddError] = useState<string>();
  const target = agents?.find((a) => a._id === sheet?.id);
  const missing = PROVIDERS.filter((p) =>
    p.id === "other" ? !agents?.some((a) => a.status !== "revoked" && a.name.toLowerCase() === p.name.toLowerCase()) : !agents?.some((a) => a.provider === p.id),
  );

  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle action={<FreezeAll className="h-9 px-3 text-label lg:hidden" />}>Agents</PageTitle>
      <Link
        href="/agents/docs"
        className="press mb-4 flex items-center gap-3 rounded-card border border-line bg-white px-4 py-3 text-body hover:border-cyan"
      >
        <BookOpen className="size-5 shrink-0 text-cyan-ink" />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-ink">Docs for connecting an AI agent</span>
          <span className="block text-label text-mute">Configs for Claude Code, Cursor, Hermes, OpenClaw and curl; tools, outcomes and limits</span>
        </span>
      </Link>
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
              onToggle={async () => {
                const token = await setStatus({ agentId: a._id, status: a.status === "active" ? "frozen" : "active" });
                if (token) window.location.assign(approvalLink(token));
              }}
              onConnect={() => setSheet({ id: a._id, kind: "connect" })}
              onPermissions={() => setSheet({ id: a._id, kind: "permissions" })}
            />
          ))}
          {(
            <button
              onClick={() => setAdding(true)}
              className="press card flex min-h-[200px] flex-col items-center justify-center gap-2 border-2 border-dashed border-line text-navy hover:border-cyan"
            >
              <Plus className="size-6" />
              <span className="text-body font-semibold">Connect an assistant</span>
              <span className="text-label text-mute">Claude Code, Cursor, Hermes or any other MCP assistant</span>
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
              key={p.label}
              onClick={async () => {
                const id = await add(p.id === "other" ? { provider: "other", name: p.name } : { provider: p.id });
                setAdding(false);
                setSheet({ id, kind: "connect" });
              }}
              className="press flex items-center gap-3 rounded-[14px] border border-line p-3 text-left hover:border-[#cfd8e3]"
            >
              <AgentMark provider={p.id} name={p.label} size={36} />
              <span className="min-w-0">
                <span className="block text-body font-semibold">{p.label}</span>
                <span className="block text-label text-mute">{p.hint}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="border-t border-line pt-4 pb-4">
          <div className="mb-2 flex items-center gap-1.5 text-label font-semibold text-ink-2">
            <Clock className="size-3.5" /> Coming soon
          </div>
          <div className="grid grid-cols-3 gap-2">
            {OAUTH_ONLY.map((p) => (
              <div key={p.label} aria-disabled className="flex flex-col items-center gap-1.5 rounded-[14px] border border-dashed border-line p-3 text-center opacity-70">
                <span className="grayscale">
                  <AgentMark provider={p.id} size={28} />
                </span>
                <span className="text-label font-semibold text-ink-2">{p.label}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-label text-mute">
            Their connectors sign in with OAuth, which isn't available yet, so they can't connect today.{" "}
            <Link href="/agents/docs#connect" className="font-semibold text-cyan-ink">
              What works now
            </Link>
          </p>
        </div>
        <form
          className="space-y-2 border-t border-line pt-4 pb-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setAddError(undefined);
            try {
              const id = await add({ provider: "other", name: otherName });
              setAdding(false);
              setOtherName("");
              setSheet({ id, kind: "connect" });
            } catch (err) {
              setAddError(errorMessage(err));
            }
          }}
        >
          <label className="block text-label font-semibold text-ink-2" htmlFor="other-assistant">
            Any other assistant that speaks MCP
          </label>
          <div className="flex gap-2">
            <input
              id="other-assistant"
              value={otherName}
              onChange={(e) => setOtherName(e.target.value)}
              placeholder="Codex, Gemini CLI, Instinct…"
              maxLength={30}
              className="h-11 min-w-0 flex-1 rounded-btn border border-line px-3 text-body"
            />
            <Button type="submit" disabled={!otherName.trim()}>
              Add
            </Button>
          </div>
          {addError && <p className="text-label text-red">{addError}</p>}
          <p className="text-label text-mute">It gets its own key and its own limits, like any other assistant.</p>
        </form>
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
        <div className={cn(frozen && "opacity-60")}>
          <AgentMark provider={a.provider} name={a.name} size={44} mood={frozen ? "sleep" : a.status === "revoked" ? "grumpy" : pending ? "neutral" : "happy"} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-title font-semibold">{a.name}</span>
            {a.freezing ? (
              <Chip tone="amber">
                <Snowflake className="size-3" /> Freezing in vault…
              </Chip>
            ) : frozen ? (
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
            {a.vault && (
              <div className="mt-1 text-label text-mute">
                Vault enforces {formatMoney(a.vault.perPaymentMinor, "USDC")} · {formatMoney(a.vault.dailyCapMinor, "USDC")} per 24h
                {a.vault.strikes > 0 && <span className="text-amber"> · {a.vault.strikes} of 5 strikes</span>}
              </div>
            )}
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
