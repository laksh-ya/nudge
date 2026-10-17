"use client";

import { useMutation, useQuery } from "convex/react";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ShieldAlert, TriangleAlert } from "lucide-react";
import { api } from "@/lib/api";
import { SCOPES } from "@/components/agents/agent-sheets";
import { Button, Card, PageTitle, Skeleton } from "@/components/ui";
import { Choice, ErrorText, Field, MoneyInput, Select, Toggle, errorMessage, toMinorUnits } from "@/components/form";

type Scope = (typeof SCOPES)[number]["id"];

/**
 * MCP OAuth consent (issue #14; only reachable when the deployment turns MCP_OAUTH on). The owner
 * decides here what the connecting assistant may do, its limits and how long access lasts. The
 * assistant gets only a code for its registered redirect URI, never anything that approves money.
 */
export default function AuthorizePage() {
  return (
    <Suspense fallback={<Skeleton className="mx-auto h-96 max-w-lg rounded-card" />}>
      <Consent />
    </Suspense>
  );
}

function Consent() {
  const p = useSearchParams();
  const clientId = p.get("client_id") ?? "";
  const redirectUri = p.get("redirect_uri") ?? "";
  const info = useQuery(api.oauth.consentInfo, { clientId, redirectUri });
  const approve = useMutation(api.oauth.approve);
  const asked = (p.get("scope") ?? "read").split(" ").filter((s): s is Scope => SCOPES.some((x) => x.id === s));
  const [scopes, setScopes] = useState<Scope[]>(asked.includes("read") ? asked : ["read", ...asked]);
  const [daily, setDaily] = useState("10");
  const [per, setPer] = useState("5");
  const [hide, setHide] = useState(true);
  const [days, setDays] = useState("30");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const spend = scopes.includes("spend");

  if (info === undefined) return <Skeleton className="mx-auto h-96 max-w-lg rounded-card" />;
  if (info === null || !info.enabled || !info.valid) {
    return (
      <div className="mx-auto max-w-lg">
        <PageTitle>Connect an assistant</PageTitle>
        <Card>
          <p className="text-body text-ink-2">
            {info?.enabled === false
              ? "Connecting assistants with OAuth isn't available yet. Use an access key from the Agents screen instead."
              : "This connection request isn't valid. Start again from your assistant."}
          </p>
        </Card>
      </div>
    );
  }

  const deny = () => {
    const u = new URL(redirectUri);
    u.searchParams.set("error", "access_denied");
    const state = p.get("state");
    if (state) u.searchParams.set("state", state);
    window.location.assign(u.toString());
  };

  return (
    <div className="mx-auto max-w-lg">
      <PageTitle>Connect {info.name}</PageTitle>
      <Card>
        <div className="space-y-4">
          <p className="text-body text-ink-2">
            <b className="text-ink">{info.name}</b> wants to connect to your wallet over MCP. You'll return to <b className="text-ink">{info.returnsTo}</b>.
          </p>
          <p className="flex items-start gap-2 rounded-btn bg-amber-soft p-3 text-label text-amber">
            <ShieldAlert className="mt-px size-4 shrink-0" />
            The name comes from the assistant and isn't verified. Only continue if you started this from {info.returnsTo}.
          </p>
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
            </Select>
          </Field>
          <p className="flex items-start gap-2 text-label text-mute">
            <TriangleAlert className="mt-px size-3.5 shrink-0" />
            Anything over these limits still comes to you for your passkey. You can freeze or disconnect it any time on the Agents screen.
          </p>
          <ErrorText>{error}</ErrorText>
          <div className="flex gap-2">
            <Button tone="outline" className="flex-1" onClick={deny} disabled={busy}>
              Cancel
            </Button>
            <Button
              className="flex-1"
              disabled={busy}
              onClick={async () => {
                setError(undefined);
                setBusy(true);
                try {
                  const to = await approve({
                    clientId,
                    redirectUri,
                    codeChallenge: p.get("code_challenge") ?? "",
                    codeChallengeMethod: "S256",
                    state: p.get("state") ?? undefined,
                    scopes,
                    dailyCapMinor: spend ? (toMinorUnits(daily, "USD") ?? 0) : 0,
                    perPaymentMinor: spend ? (toMinorUnits(per, "USD") ?? 0) : 0,
                    hidesBalances: hide,
                    days: Number(days),
                  });
                  window.location.assign(to);
                } catch (e) {
                  setError(errorMessage(e));
                  setBusy(false);
                }
              }}
            >
              Allow
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
