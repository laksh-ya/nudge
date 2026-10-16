"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { Check, Copy, KeyRound, TriangleAlert } from "lucide-react";
import { api, type Doc } from "@/lib/api";

export type AgentView = Omit<Doc<"agents">, "tokenHash"> & { hasKey: boolean };
import { MCP_URL, approvalLink } from "@/lib/config";
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

export function ConnectSheet({ agent, onClose }: { agent: AgentView; onClose: () => void }) {
  const issue = useMutation(api.gateway.issueToken);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const slug = agent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={`Connect ${agent.name}`}>
      <div className="space-y-4 pb-4">
        <p className="text-body text-ink-2">
          {agent.name} connects over MCP with its own key. It can only do what you allow on this screen, and you can freeze or disconnect it any time.
        </p>
        <CopyRow label="Server URL" value={MCP_URL} />
        {token ? (
          <>
            <CopyRow label="Access key" value={token} secret />
            <p className="flex items-start gap-2 rounded-btn bg-amber-soft p-3 text-label text-amber">
              <TriangleAlert className="mt-px size-4 shrink-0" />
              Copy it now. It won't be shown again. Making a new key turns this one off.
            </p>
            <CopyRow label="Claude Code" value={`claude mcp add --transport http ${slug}-wallet ${MCP_URL} --header "Authorization: Bearer ${token}"`} />
            <CopyRow
              label="Any MCP client (JSON config)"
              value={JSON.stringify({ mcpServers: { [`${slug}-wallet`]: { type: "http", url: MCP_URL, headers: { Authorization: `Bearer ${token}` } } } })}
            />
            <CopyRow label="Hermes (config.yaml)" value={`mcp_servers:\n  ${slug}-wallet:\n    url: ${MCP_URL}\n    headers:\n      Authorization: Bearer ${token}`} />
            <p className="text-label text-mute">
              Any assistant works if it can add a remote MCP server (streamable HTTP) with an Authorization header: this URL, and "Bearer" plus the key.
            </p>
            <Button size="lg" className="w-full" onClick={onClose}>
              Done
            </Button>
          </>
        ) : (
          <>
            <ErrorText>{error}</ErrorText>
            <Button
              size="lg"
              icon={KeyRound}
              className="w-full"
              onClick={async () => {
                try {
                  setToken(await issue({ agentId: agent._id }));
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            >
              {agent.hasKey ? "Make a new key" : "Create access key"}
            </Button>
          </>
        )}
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
