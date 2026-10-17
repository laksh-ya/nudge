"use client";

import Link from "next/link";
import { useMutation } from "convex/react";
import { useState } from "react";
import { BookOpen, Check, Copy, Info, KeyRound, TriangleAlert } from "lucide-react";
import { api, type Doc } from "@/lib/api";
import { MCP_URL, approvalLink } from "@/lib/config";
import { mcpSnippets } from "@/lib/mcp-snippets";

export type AgentView = Omit<Doc<"agents">, "tokenHash"> & { hasKey: boolean };
import { Button, Sheet } from "../ui";
import { Choice, ErrorText, Field, MoneyInput, Select, Toggle, errorMessage, toMinorUnits } from "../form";

function CopyRow({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mb-1 text-label font-semibold text-ink-2">{label}</div>
      <div className="flex items-center gap-2 rounded-btn border border-line bg-page px-3 py-2">
        <code className={`num min-w-0 flex-1 truncate text-label ${secret ? "text-navy" : "text-ink"}`}>{value}</code>
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
          className="press shrink-0 text-cyan-ink"
          aria-label={`Copy ${label}`}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </button>
      </div>
    </div>
  );
}

/** Which snippet to show first for each preset; the rest stay one tap away. */
const FIRST: Record<string, string> = { claude: "claude-code", hermes: "hermes", openclaw: "openclaw" };

export function ConnectSheet({ agent, onClose }: { agent: AgentView; onClose: () => void }) {
  const issue = useMutation(api.gateway.issueToken);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const slug = agent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const readOnly = !agent.scopes.includes("prepare") && !agent.scopes.includes("spend");
  const first = FIRST[agent.provider] ?? (agent.name.toLowerCase() === "cursor" ? "cursor" : "json");
  const snippets = token ? mcpSnippets(MCP_URL, token, `${slug}-wallet`) : [];
  const ordered = [...snippets.filter((x) => x.id === first), ...snippets.filter((x) => x.id !== first)];
  const create = async () => {
    try {
      setError(undefined);
      setToken(await issue({ agentId: agent._id }));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={`Connect ${agent.name}`}>
      <div className="space-y-4 pb-4">
        <p className="text-body text-ink-2">
          {agent.name} connects over MCP with its own key. It can only do what you allow on this screen, and you can freeze or disconnect it any time.
        </p>
        {agent.provider === "chatgpt" && (
          <p className="flex items-start gap-2 rounded-btn bg-amber-soft p-3 text-label text-amber">
            <Info className="mt-px size-4 shrink-0" />
            ChatGPT's connectors sign in with OAuth, which isn't available yet, so ChatGPT itself can't connect today. A key works in clients that let you add an
            Authorization header.
          </p>
        )}
        {readOnly && (
          <p className="flex items-start gap-2 rounded-btn bg-sky-soft p-3 text-label text-navy">
            <Info className="mt-px size-4 shrink-0" />
            It starts read-only: it can see money but not pay. To let it pay, open Limits on its card.
          </p>
        )}
        <CopyRow label="Server URL" value={MCP_URL} />
        {token ? (
          <>
            <CopyRow label="Access key" value={token} secret />
            <p className="flex items-start gap-2 rounded-btn bg-amber-soft p-3 text-label text-amber">
              <TriangleAlert className="mt-px size-4 shrink-0" />
              Copy it now. It won't be shown again. Making a new key turns this one off.
            </p>
            {(showAll ? ordered : ordered.slice(0, 1)).map((x) => (
              <CopyRow key={x.id} label={`${x.label} · ${x.where}`} value={x.code} />
            ))}
            {!showAll && (
              <button onClick={() => setShowAll(true)} className="press text-label font-semibold text-cyan-ink">
                Show Cursor, Hermes, OpenClaw, JSON and curl
              </button>
            )}
            <p className="text-label text-mute">
              Any assistant works if it can add a remote MCP server (streamable HTTP) with an Authorization header: this URL, and "Bearer" plus the key.
            </p>
            <Button size="lg" className="w-full" onClick={onClose}>
              Done
            </Button>
          </>
        ) : confirmRotate ? (
          <div className="space-y-3 rounded-btn border border-line p-3">
            <p className="text-body text-ink-2">
              {agent.name}'s current key stops working at once. Anything set up with it needs the new key.
            </p>
            <ErrorText>{error}</ErrorText>
            <div className="flex gap-2">
              <Button tone="outline" className="flex-1" onClick={() => setConfirmRotate(false)}>
                Keep the old key
              </Button>
              <Button tone="danger" className="flex-1" onClick={create}>
                Replace it
              </Button>
            </div>
          </div>
        ) : (
          <>
            <ErrorText>{error}</ErrorText>
            <Button size="lg" icon={KeyRound} className="w-full" onClick={agent.hasKey ? () => setConfirmRotate(true) : create}>
              {agent.hasKey ? "Make a new key" : "Create access key"}
            </Button>
          </>
        )}
        <Link href="/agents/docs" className="press flex items-center justify-center gap-1.5 text-label font-semibold text-cyan-ink">
          <BookOpen className="size-3.5" /> Setup docs, tools and limits
        </Link>
      </div>
    </Sheet>
  );
}

const SCOPES = [
  { id: "read" as const, label: "See money", hint: "Overview, bills and spending" },
  { id: "prepare" as const, label: "Prepare payments", hint: "Drafts that come to you" },
  { id: "spend" as const, label: "Pay within limits", hint: "From the agent wallet only" },
  { id: "request" as const, label: "Ask for more", hint: "Send you approval links" },
];

export function PermissionsSheet({ agent, onClose }: { agent: AgentView; onClose: () => void }) {
  const update = useMutation(api.gateway.updateGrant);
  const revoke = useMutation(api.gateway.revoke);
  const [scopes, setScopes] = useState(agent.scopes);
  const [daily, setDaily] = useState(agent.dailyCapMinor ? String(agent.dailyCapMinor / 100) : "10");
  const [per, setPer] = useState(agent.perPaymentMinor ? String(agent.perPaymentMinor / 100) : "5");
  const [hide, setHide] = useState(agent.hidesBalances);
  const [days, setDays] = useState(String(Math.max(1, Math.round((agent.expiresAt - Date.now()) / 86_400_000)) || 30));
  const [error, setError] = useState<string>();
  const spend = scopes.includes("spend");
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={`What ${agent.name} may do`}>
      <div className="space-y-4 pb-4">
        <div className="grid gap-2">
          {SCOPES.map((s) => (
            <Choice
              key={s.id}
              selected={scopes.includes(s.id)}
              onClick={() => setScopes((x) => (s.id === "read" ? x : x.includes(s.id) ? x.filter((y) => y !== s.id) : [...x, s.id]))}
            >
              <span>
                <span className="block font-semibold">{s.label}</span>
                <span className="block text-label text-mute">{s.hint}</span>
              </span>
            </Choice>
          ))}
        </div>
        {spend && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Per day">
              <MoneyInput currency="USD" value={daily} onChange={setDaily} />
            </Field>
            <Field label="Per payment">
              <MoneyInput currency="USD" value={per} onChange={setPer} />
            </Field>
          </div>
        )}
        <div className="flex items-center justify-between gap-3 rounded-btn border border-line px-3 py-2.5">
          <div>
            <div className="text-body font-semibold">Hide balances</div>
            <div className="text-label text-mute">It still sees bills and can check if something is affordable</div>
          </div>
          <Toggle checked={hide} onChange={setHide} label="Hide balances" />
        </div>
        <Field label="Access lasts">
          <Select value={days} onChange={(e) => setDays(e.target.value)}>
            {["1", "7", "30", "90", "365"].map((d) => (
              <option key={d} value={d}>
                {d === "1" ? "1 day" : `${d} days`}
              </option>
            ))}
            {!["1", "7", "30", "90", "365"].includes(days) && <option value={days}>{days} days</option>}
          </Select>
        </Field>
        <ErrorText>{error}</ErrorText>
        <Button
          size="lg"
          className="w-full"
          onClick={async () => {
            setError(undefined);
            try {
              const token = await update({
                agentId: agent._id,
                scopes,
                dailyCapMinor: spend ? (toMinorUnits(daily, "USD") ?? 0) : 0,
                perPaymentMinor: spend ? (toMinorUnits(per, "USD") ?? 0) : 0,
                hidesBalances: hide,
                days: Number(days),
              });
              onClose();
              if (token) window.location.assign(approvalLink(token));
            } catch (e) {
              setError(errorMessage(e));
            }
          }}
        >
          Save
        </Button>
        {agent.provider !== "own" && (
          <Button
            tone="danger"
            className="w-full"
            onClick={async () => {
              const token = await revoke({ agentId: agent._id });
              onClose();
              // Its vault key is frozen already; this approval removes it from the vault for good.
              if (token) window.location.assign(approvalLink(token));
            }}
          >
            Disconnect {agent.name}
          </Button>
        )}
      </div>
    </Sheet>
  );
}
