"use client";

import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { BookOpen, Check, Copy, Info, KeyRound, TriangleAlert } from "lucide-react";
import { api, type Doc, type Id } from "@/lib/api";
import { MCP_URL, approvalLink } from "@/lib/config";
import { mcpSnippets } from "@/lib/mcp-snippets";
import { setupPrompt } from "@agent-wallet/backend/guide";

export type AgentView = Omit<Doc<"agents">, "tokenHash"> & {
  hasKey: boolean;
  recent?: { _id: string; title: string; amountMinor: number; state: string; at: number }[];
};
import { Button, Sheet } from "../ui";
import { ErrorText, Field, MoneyInput, Select, Toggle, errorMessage, toMinorUnits } from "../form";

/** The one thing to paste into an assistant: it connects itself and reads the agent guide. */
function SetupText({ text, agentName }: { text: string; agentName: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-btn border border-cyan/40 bg-sky-soft p-3">
      <div className="text-body font-semibold text-ink">Paste this into {agentName}</div>
      <p className="mt-0.5 text-label text-ink-2">It connects itself, reads the guide written for agents and checks its limits. Nothing else to configure.</p>
      <pre className="num mt-2 max-h-40 overflow-auto rounded-btn bg-white p-2 text-[12px] leading-[17px] whitespace-pre-wrap text-ink">{text}</pre>
      <Button
        className="mt-2 w-full"
        icon={copied ? Check : Copy}
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
      >
        {copied ? "Copied" : "Copy setup text"}
      </Button>
    </div>
  );
}

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
  const asksEveryTime = !agent.scopes.includes("spend") || agent.perPaymentMinor === 0;
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
          {agent.name} connects over MCP with its own key. Inside the limits you set it acts on its own; anything else comes to you as a link you approve with
          your passkey. Freeze or disconnect it any time.
        </p>
        {agent.provider === "chatgpt" && (
          <p className="flex items-start gap-2 rounded-btn bg-amber-soft p-3 text-label text-amber">
            <Info className="mt-px size-4 shrink-0" />
            ChatGPT's connectors sign in with OAuth, which isn't available yet, so ChatGPT itself can't connect today. A key works in clients that let you add an
            Authorization header.
          </p>
        )}
        {asksEveryTime && (
          <p className="flex items-start gap-2 rounded-btn bg-sky-soft p-3 text-label text-navy">
            <Info className="mt-px size-4 shrink-0" />
            It starts by asking you before every payment. To let it pay small amounts on its own, open Limits on its card.
          </p>
        )}
        {token ? (
          <>
            <SetupText text={setupPrompt({ mcpUrl: MCP_URL, key: token, agentName: agent.name, webUrl: typeof window === "undefined" ? undefined : window.location.origin })} agentName={agent.name} />
            <p className="flex items-start gap-2 rounded-btn bg-amber-soft p-3 text-label text-amber">
              <TriangleAlert className="mt-px size-4 shrink-0" />
              The text includes the key. It won't be shown again; making a new key turns this one off.
            </p>
            <details className="rounded-btn border border-line p-3" open={showAll} onToggle={(e) => setShowAll((e.target as HTMLDetailsElement).open)}>
              <summary className="cursor-pointer text-label font-semibold text-cyan-ink">Configure by hand instead</summary>
              <div className="mt-3 space-y-3">
                <CopyRow label="Server URL" value={MCP_URL} />
                <CopyRow label="Access key" value={token} secret />
                {ordered.map((x) => (
                  <CopyRow key={x.id} label={`${x.label} · ${x.where}`} value={x.code} />
                ))}
              </div>
            </details>
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

export function PermissionsSheet({ agent, onClose }: { agent: AgentView; onClose: () => void }) {
  const update = useMutation(api.gateway.updateGrant);
  const revoke = useMutation(api.gateway.revoke);
  const [alone, setAlone] = useState(agent.scopes.includes("spend") && agent.perPaymentMinor > 0);
  const [daily, setDaily] = useState(agent.dailyCapMinor ? String(agent.dailyCapMinor / 100) : "10");
  const [per, setPer] = useState(agent.perPaymentMinor ? String(agent.perPaymentMinor / 100) : "2");
  const [hide, setHide] = useState(agent.hidesBalances);
  const [days, setDays] = useState(String(Math.max(1, Math.round((agent.expiresAt - Date.now()) / 86_400_000)) || 30));
  const [error, setError] = useState<string>();
  const wallet = useQuery(api.wallet.get);
  const contacts = (wallet?.payees ?? []).filter((p) => p.trusted);
  const [only, setOnly] = useState<string[]>((agent.allowedPayees ?? []) as string[]);
  const [limitWho, setLimitWho] = useState(Boolean(agent.allowedPayees?.length));
  const spend = alone;
  const scopes: AgentView["scopes"] = alone ? ["read", "prepare", "spend", "request"] : ["read", "prepare", "request"];
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={`${agent.name}'s limits`}>
      <div className="space-y-4 pb-4">
        <p className="text-body text-ink-2">
          {agent.name} can always see your money and ask for anything. This sets what it may pay <b>on its own</b>; anything more comes to you as a link you
          approve with your passkey.
        </p>
        <div className="flex items-center justify-between gap-3 rounded-btn border border-line px-3 py-2.5">
          <div>
            <div className="text-body font-semibold">Pay small amounts on its own</div>
            <div className="text-label text-mute">{alone ? "Within the amounts below, to trusted contacts" : "Off: it asks you before every payment"}</div>
          </div>
          <Toggle checked={alone} onChange={setAlone} label="Pay on its own" />
        </div>
        {spend && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Up to, per payment">
              <MoneyInput currency="USD" value={per} onChange={setPer} />
            </Field>
            <Field label="Up to, per day">
              <MoneyInput currency="USD" value={daily} onChange={setDaily} />
            </Field>
          </div>
        )}
        <p className="text-label text-mute">Raising a limit needs your passkey once; lowering it applies at once. On-chain, the vault enforces these amounts itself.</p>
        {spend && (
          <div className="rounded-btn border border-line p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-body font-semibold">Only certain contacts</div>
                <div className="text-label text-mute">{limitWho ? "It pays these alone; anyone else comes to you" : "Off: any trusted contact"}</div>
              </div>
              <Toggle checked={limitWho} onChange={setLimitWho} label="Only certain contacts" />
            </div>
            {limitWho && (
              <div className="mt-2 grid max-h-44 gap-1 overflow-y-auto">
                {contacts.length === 0 && <p className="text-label text-mute">No trusted contacts yet. Add some on the Wallet screen.</p>}
                {contacts.map((p) => (
                  <label key={p._id} className="flex items-center gap-2 rounded-btn px-1 py-1.5 text-body hover:bg-page">
                    <input type="checkbox" checked={only.includes(p._id)} onChange={(e) => setOnly((x) => (e.target.checked ? [...x, p._id] : x.filter((y) => y !== p._id)))} />
                    {p.name}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="flex items-center justify-between gap-3 rounded-btn border border-line px-3 py-2.5">
          <div>
            <div className="text-body font-semibold">Hide balances</div>
            <div className="text-label text-mute">Off by default. On: it still sees bills and plans, but not amounts you hold</div>
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
                allowedPayees: (limitWho && spend ? only : []) as Id<"payees">[],
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
