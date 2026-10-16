"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { ArrowUpCircle, Clock, ExternalLink, Fingerprint, KeyRound, LoaderCircle, Plus, RefreshCw, ShieldAlert, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { api, type Id } from "@/lib/api";
import { APPROVE_URL, approvalLink } from "@/lib/config";
import { cn } from "@/lib/cn";
import { ago, formatMoney } from "@/lib/format";
import { Button, ButtonLink, Card, Chip, Divided, IconTile, Row } from "@/components/ui";
import { ErrorText, Input, MoneyInput, Select, errorMessage, toMinorUnits } from "@/components/form";
import { VAULT_VERSION, isVaultVersion } from "@agent-wallet/domain";

export type ChainStatus = NonNullable<ReturnType<typeof useQuery<typeof api.vault.status>>>;
type Vault = NonNullable<NonNullable<ChainStatus["wallet"]>["vault"]>;

function useClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function countdown(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function minutes(seconds: number) {
  if (seconds === 0) return "no wait";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${+(seconds / 3600).toFixed(1)} hours`;
}

/** Enrolment, confirmation, upgrade and backup passkeys: everything about who can sign for the vault. */
export function PasskeyCard({ chain }: { chain: ChainStatus }) {
  const startEnrol = useMutation(api.vault.startEnrol);
  const confirm = useMutation(api.vault.confirmEnrol);
  const reject = useMutation(api.vault.rejectEnrol);
  const upgrade = useMutation(api.vault.upgradeVault);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const w = chain.wallet;
  if (!w) return null;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const enrol = (purpose: "first" | "backup") =>
    run(async () => {
      const token = await startEnrol({ purpose });
      window.location.assign(`${APPROVE_URL}/enrol/${token}`);
    });

  if (w.candidate) {
    return (
      <Card>
        <div className="flex items-start gap-3">
          <IconTile icon={KeyRound} tone="amber" />
          <div className="min-w-0 flex-1">
            <div className="text-body font-semibold">{w.candidate.purpose === "backup" ? "Confirm your backup passkey" : "Confirm your payment passkey"}</div>
            <div className="text-label text-ink-2">
              Made on {w.candidate.device}, {ago(w.candidate.at)}. Type the 6-digit code that device shows. If you didn't make it, reject it.
            </div>
          </div>
        </div>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await confirm({ code });
              if ("error" in r && r.error) throw new Error(r.error);
              if (r.approvalToken) window.location.assign(approvalLink(r.approvalToken));
            });
          }}
        >
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            placeholder="123 456"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))}
            className="num flex-1 text-center tracking-[0.2em]"
            aria-label="Code from your phone"
          />
          <Button type="submit" disabled={busy || code.replace(/\s/g, "").length !== 6}>
            Confirm
          </Button>
        </form>
        <ErrorText>{error}</ErrorText>
        <button onClick={() => run(() => reject())} className="mt-2 text-label font-semibold text-red">
          I didn't make this passkey
        </button>
      </Card>
    );
  }

  if (w.status === "deploying") {
    return (
      <Card>
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-[12px] bg-sky text-navy">
            <LoaderCircle className="size-5 animate-spin" />
          </span>
          <div>
            <div className="text-body font-semibold">Creating your vault on Base Sepolia</div>
            <div className="text-label text-mute">About a minute. You can leave this page.</div>
          </div>
        </div>
      </Card>
    );
  }

  if (w.status === "live" && !isVaultVersion(w.version)) {
    return (
      <Card>
        <div className="flex items-start gap-3">
          <IconTile icon={ArrowUpCircle} tone="amber" />
          <div className="flex-1">
            <div className="text-body font-semibold">Move to the current vault</div>
            <div className="text-label text-ink-2">
              The new contract adds holds you can cancel, waiting periods on loosening, and agents that freeze themselves after repeated refusals. Same passkey; your old vault stays on-chain as history.
            </div>
          </div>
        </div>
        <ErrorText>{error}</ErrorText>
        <Button className="mt-3 w-full" disabled={busy} onClick={() => run(() => upgrade())}>
          Move with my passkey
        </Button>
      </Card>
    );
  }

  if (w.status === "live") {
    const keys = w.passkeys;
    return (
      <Card>
        <div className="flex items-center gap-3">
          <IconTile icon={ShieldCheck} tone="green" />
          <div className="min-w-0 flex-1">
            <div className="text-body font-semibold">On-chain, approved only by your passkeys</div>
            <div className="truncate text-label text-mute">For {w.rpId}</div>
          </div>
          {w.deployTx && (
            <a href={`${w.explorer}/tx/${w.deployTx}`} target="_blank" rel="noopener" className="flex items-center gap-1 text-label font-semibold text-cyan-ink">
              Deployment <ExternalLink className="size-3" />
            </a>
          )}
        </div>
        {chain.setup && (
          <div className="mt-3 flex items-center gap-3 rounded-btn bg-amber-soft p-3">
            <span className="flex-1 text-label font-medium text-amber">{chain.setup.title}: approve your agents, contacts and rules</span>
            <ButtonLink href={approvalLink(chain.setup.token!)} size="sm">
              Approve
            </ButtonLink>
          </div>
        )}
        {(w.version ?? 1) < VAULT_VERSION && (
          <div className="mt-3 rounded-btn bg-sky-soft p-3">
            <div className="text-label font-semibold">A newer vault contract is available (v{VAULT_VERSION})</div>
            <div className="text-label text-ink-2">
              Disconnecting an agent also stops its held payments, revoking voids older approvals, and paying a new address waits so it can be cancelled. Same passkey; your current vault stays on-chain as history.
            </div>
            <Button size="sm" className="mt-2" disabled={busy} onClick={() => run(() => upgrade())}>
              Move with my passkey
            </Button>
          </div>
        )}
        <Divided className="mt-2">
          {keys.map((k) => (
            <Row
              key={k.keyId}
              leading={<IconTile icon={Fingerprint} tone={k.status === "active" ? "sky" : "amber"} />}
              title={k.label}
              sub={k.status === "active" ? `Added ${ago(k.addedAt)}` : "Waiting for your approval and the vault's delay"}
              trailing={k.status === "adding" ? <Chip tone="amber">Adding</Chip> : undefined}
            />
          ))}
        </Divided>
        {keys.length < 2 && (
          <p className="mt-2 flex items-start gap-1.5 text-label text-amber">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> With one passkey, losing that device locks the vault. Add a backup on another device.
          </p>
        )}
        <ErrorText>{error}</ErrorText>
        {keys.length < 3 && (
          <Button tone="ghost" icon={Plus} className="mt-2 w-full" disabled={busy} onClick={() => enrol("backup")}>
            Add backup passkey
          </Button>
        )}
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-start gap-3">
        <IconTile icon={w.status === "error" ? TriangleAlert : Fingerprint} tone={w.status === "error" ? "red" : "sky"} />
        <div className="flex-1">
          <div className="text-body font-semibold">Put this wallet on-chain</div>
          <div className="text-label text-ink-2">
            Create a payment passkey on your phone. After you confirm it here, a vault contract is deployed for it, and only your passkey can approve anything above your limits.
          </div>
          {w.status === "error" && <div className="mt-1 text-label text-red">{w.statusNote}</div>}
        </div>
      </div>
      <ErrorText>{error}</ErrorText>
      <Button icon={Fingerprint} className="mt-3 w-full" disabled={busy} onClick={() => enrol("first")}>
        {w.status === "error" ? "Try again" : "Create payment passkey"}
      </Button>
    </Card>
  );
}

/** Held agent payments and queued loosening, each with its own countdown and a cancel. */
export function WaitingCard({ chain }: { chain: ChainStatus }) {
  const cancel = useMutation(api.vault.cancelWaiting);
  const now = useClock();
  const [error, setError] = useState<string>();
  if (!chain.waiting.length) return null;
  return (
    <Card title="Waiting in the vault">
      <Divided>
        {chain.waiting.map((t) => {
          const at = t.state === "held" ? t.releaseAt : t.readyAt;
          const unknown = t.state === "unknown";
          return (
            <Row
              key={t._id}
              leading={<IconTile icon={unknown ? ShieldAlert : Clock} tone="amber" />}
              title={`${t.title}${t.amountMinor ? ` · ${formatMoney(t.amountMinor, "USDC")}` : ""}`}
              sub={
                unknown
                  ? t.reason
                  : t.reason?.startsWith("Cancelling") || t.reason?.startsWith("Couldn't")
                    ? t.reason
                    : `${t.state === "held" ? "Leaves" : "Applies"} in ${countdown((at ?? now) - now)}`
              }
              trailing={
                unknown ? (
                  t.txHash ? (
                    <a href={`https://sepolia.basescan.org/tx/${t.txHash}`} target="_blank" rel="noopener" className="text-label font-semibold text-cyan-ink">
                      Explorer
                    </a>
                  ) : undefined
                ) : (
                  <Button size="sm" tone="danger" icon={X} onClick={() => cancel({ taskId: t._id }).catch((e) => setError(errorMessage(e)))}>
                    Cancel
                  </Button>
                )
              }
            />
          );
        })}
      </Divided>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

type Verdict = { tone: "green" | "amber" | "red"; title: string; detail: string };

/** The same checks, in the same order, as PolicyVault._refusal, run on the numbers we last read from it. */
function check(v: Vault, a: NonNullable<AgentRow["vault"]>, name: string, amountMinor: number, newContact: boolean): Verdict {
  const refuse = (code: number, detail: string): Verdict => ({ tone: "red", title: `Refused on-chain · code ${code}`, detail });
  if (v.frozen || a.frozen) return { tone: "red", title: "Reverts: frozen", detail: `${a.frozen ? name : "The vault"} is frozen. Nothing leaves until your passkey unfreezes it.` };
  if (!a.active) return { tone: "red", title: "Reverts: not an agent", detail: `${name}'s key isn't registered in the vault.` };
  if (a.expiresAt < Date.now()) return refuse(2001, `${name}'s access expired.`);
  if (newContact) return refuse(2002, "A new contact waits before agents can pay it. You can still pay it yourself with your passkey.");
  if (amountMinor === 0 || amountMinor > a.perPaymentMinor) return refuse(2003, `Above ${name}'s ${formatMoney(a.perPaymentMinor, "USDC")} per-payment limit.`);
  if (a.spentMinor + amountMinor > a.dailyCapMinor)
    return refuse(2003, `${name} has spent ${formatMoney(a.spentMinor, "USDC")} of ${formatMoney(a.dailyCapMinor, "USDC")} in the last 24 hours.`);
  if (v.spentMinor + amountMinor > v.ceilingMinor) return refuse(2004, `All agents have spent ${formatMoney(v.spentMinor, "USDC")} of the ${formatMoney(v.ceilingMinor, "USDC")} ceiling.`);
  if (amountMinor + v.protectedMinor > v.balanceMinor - v.heldMinor) return refuse(2005, `It would leave less than the ${formatMoney(v.protectedMinor, "USDC")} protected from agents.`);
  if (v.holdFor > 0 && amountMinor > v.holdAboveMinor)
    return { tone: "amber", title: `Held ${minutes(v.holdFor)}, then paid`, detail: `Above ${formatMoney(v.holdAboveMinor, "USDC")}, so you get ${minutes(v.holdFor)} to cancel before it leaves.` };
  return { tone: "green", title: "Paid at once", detail: "Inside every limit. The vault pays the saved contact directly." };
}

type AgentRow = NonNullable<ReturnType<typeof useQuery<typeof api.agents.list>>>[number];

/** "What could go wrong right now?" answered from the vault's own numbers, plus a try-it box. */
export function RulesCard({ chain }: { chain: ChainStatus }) {
  const agents = useQuery(api.agents.list);
  const refresh = useMutation(api.vault.refresh);
  const [agentId, setAgentId] = useState<string>("");
  const [amount, setAmount] = useState("12");
  const [newContact, setNewContact] = useState(false);
  const v = chain.wallet?.vault;
  if (!v) return null;
  const keyed = (agents ?? []).filter((a) => a.vault);
  const chosen = keyed.find((a) => a._id === agentId) ?? keyed[0];
  const minor = toMinorUnits(amount, "USDC") ?? 0;
  const verdict = chosen?.vault ? check(v, chosen.vault, chosen.name, minor, newContact) : null;
  const binding = v.frozen ? "the vault is frozen" : v.headroomMinor === v.ceilingMinor - v.spentMinor ? "the daily ceiling for all agents" : "the protected amount";

  return (
    <Card
      title="Test my rules"
      action={
        <button onClick={() => refresh()} className="press flex items-center gap-1 text-label font-semibold text-cyan-ink" aria-label="Read the vault again">
          <RefreshCw className="size-3.5" /> {ago(v.syncedAt)}
        </button>
      }
    >
      <div className="rounded-btn bg-navy p-4 text-white">
        <div className="text-label text-white/70">If every agent were hijacked right now</div>
        <div className="figure mt-0.5 text-figure">{formatMoney(v.headroomMinor, "USDC", { cents: true })}</div>
        <div className="text-label text-white/70">
          is the most that could leave in the next 24 hours, set by {binding}. Payments you approve yourself aren't counted.
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-label">
        <div>
          <dt className="text-mute">Loosening waits</dt>
          <dd className="font-semibold">{minutes(v.changeDelay)}</dd>
        </div>
        <div>
          <dt className="text-mute">Agent payments held</dt>
          <dd className="font-semibold">{v.holdFor ? `above ${formatMoney(v.holdAboveMinor, "USDC")}, ${minutes(v.holdFor)}` : "never"}</dd>
        </div>
        <div>
          <dt className="text-mute">New contacts wait</dt>
          <dd className="font-semibold">{minutes(v.contactDelay)}</dd>
        </div>
        <div>
          <dt className="text-mute">Held right now</dt>
          <dd className="num font-semibold">{formatMoney(v.heldMinor, "USDC")}</dd>
        </div>
      </dl>

      {keyed.length > 0 && chosen?.vault && (
        <div className="mt-4 rounded-btn border border-line p-3">
          <div className="text-label font-semibold">Try a payment</div>
          <div className="mt-2 grid grid-cols-[1fr_110px] gap-2">
            <Select value={chosen._id} onChange={(e) => setAgentId(e.target.value)} aria-label="Agent">
              {keyed.map((a) => (
                <option key={a._id} value={a._id}>
                  {a.name}
                </option>
              ))}
            </Select>
            <MoneyInput currency="USDC" value={amount} onChange={setAmount} />
          </div>
          <label className="mt-2 flex items-center gap-2 text-label text-ink-2">
            <input type="checkbox" checked={newContact} onChange={(e) => setNewContact(e.target.checked)} /> To a contact added today
          </label>
          {verdict && (
            <div
              className={cn(
                "mt-3 rounded-btn p-3 text-label",
                verdict.tone === "green" ? "bg-green-soft text-green" : verdict.tone === "amber" ? "bg-amber-soft text-amber" : "bg-red-soft text-red",
              )}
            >
              <div className="font-semibold">{verdict.title}</div>
              <div className="mt-0.5 text-ink-2">{verdict.detail}</div>
            </div>
          )}
          <p className="mt-2 text-micro text-mute">
            {chosen.name}: {formatMoney(chosen.vault.spentMinor, "USDC")} spent of {formatMoney(chosen.vault.dailyCapMinor, "USDC")} in 24 hours ·{" "}
            {chosen.vault.strikes} of 5 strikes. Read from the vault, not our database. Nothing is sent.
          </p>
        </div>
      )}
    </Card>
  );
}

type Payee = { _id: Id<"payees">; name: string; onchain?: boolean; dailyCapMinor?: number };

/** One limit per contact for all agents together, per 24 hours. Enforced by v3 vaults. */
export function ContactLimitForm({ chain, payees }: { chain: ChainStatus; payees: Payee[] }) {
  const setCap = useMutation(api.vault.setContactCap);
  const inVault = payees.filter((p) => p.onchain);
  const [payeeId, setPayeeId] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const w = chain.wallet;
  if (!w || w.status !== "live" || (w.version ?? 0) < 3 || inVault.length === 0) return null;
  const chosen = inVault.find((p) => p._id === payeeId) ?? inVault[0]!;

  async function save(capMinor: number) {
    setBusy(true);
    setError(null);
    try {
      const token = await setCap({ payeeId: chosen._id, dailyCapMinor: capMinor });
      window.location.assign(approvalLink(token));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const minor = toMinorUnits(amount, "USDC");
  return (
    <div className="mx-4 mb-4 rounded-btn border border-line p-3">
      <div className="text-label font-semibold">Limit what agents pay one contact</div>
      <p className="text-micro text-mute">All agents together, per 24 hours. Lowering applies when you approve; raising waits out the vault&apos;s delay.</p>
      <div className="mt-2 grid grid-cols-[1fr_110px] gap-2">
        <Select value={chosen._id} onChange={(e) => setPayeeId(e.target.value)} aria-label="Contact">
          {inVault.map((p) => (
            <option key={p._id} value={p._id}>
              {p.name}
              {p.dailyCapMinor ? ` (now ${formatMoney(p.dailyCapMinor, "USDC")})` : ""}
            </option>
          ))}
        </Select>
        <MoneyInput currency="USDC" value={amount} onChange={setAmount} placeholder="20" />
      </div>
      <ErrorText>{error}</ErrorText>
      <div className="mt-2 flex gap-2">
        <Button size="sm" disabled={busy || !minor || minor <= 0} onClick={() => minor && save(minor)}>
          Set limit with my passkey
        </Button>
        {chosen.dailyCapMinor ? (
          <Button size="sm" tone="ghost" disabled={busy} onClick={() => save(0)}>
            Remove limit
          </Button>
        ) : null}
      </div>
    </div>
  );
}
