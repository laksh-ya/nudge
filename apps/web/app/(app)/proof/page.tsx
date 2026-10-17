"use client";

import { useConvexAuth, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createPublicClient, formatUnits, getAddress, http, isAddress, parseEventLogs, type Address, type Hex } from "viem";
import { ExternalLink, Radio, ShieldCheck } from "lucide-react";
import {
  CHAIN_ID,
  addressLabels,
  contactIdOf,
  contactLabels,
  describeEvent,
  exposure,
  isVaultVersion,
  policyVaultAbi,
  testUsdAbi,
  type Exposure,
  type ProofEvent,
  type ProofLine,
} from "@agent-wallet/domain";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { EXPLORER, REFERENCE_VAULT, REFERENCE_VAULTS } from "@/lib/config";
import { Button, Card, Divided, Empty, PageTitle, Skeleton } from "@/components/ui";
import { Input } from "@/components/form";

/** Read straight from Base Sepolia in this browser: our server is not in the path. */
const chain = {
  id: CHAIN_ID,
  name: "Base Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia.base.org"] } },
} as const;
const pub = createPublicClient({ chain, transport: http(undefined, { retryCount: 3 }) });
/** Blockscout's public index for Base Sepolia, used only to find transaction hashes. */
const INDEX = "https://base-sepolia.blockscout.com/api/v2";
const REPO = "https://github.com/laksh-ya/nudge/tree/main";

const usd = (units: bigint) => `$${Number(formatUnits(units, 6)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Which transactions touched the vault: the public node only answers 200-block log queries, so a
 * block explorer's index finds them. The explorer only points; every event shown is decoded from
 * the receipt fetched from Base Sepolia itself, keeping only logs the vault emitted.
 */
async function vaultTransactions(vault: Address, deployTx?: Hex) {
  const hashes = new Set<Hex>(deployTx ? [deployTx] : []);
  let params: Record<string, string> | null = {};
  for (let page = 0; page < 20 && params; page++) {
    const q = new URLSearchParams(params).toString();
    const res = await fetch(`${INDEX}/addresses/${vault}/logs${q ? `?${q}` : ""}`);
    if (!res.ok) throw new Error(`The explorer index answered ${res.status}`);
    const body = (await res.json()) as { items: { transaction_hash: Hex }[]; next_page_params: Record<string, string | number> | null };
    for (const item of body.items) hashes.add(item.transaction_hash);
    params = body.next_page_params ? Object.fromEntries(Object.entries(body.next_page_params).map(([k, v]) => [k, String(v)])) : null;
  }
  return [...hashes];
}

async function vaultLog(vault: Address, deployTx?: Hex) {
  const hashes = await vaultTransactions(vault, deployTx);
  const events: ProofEvent[] = [];
  for (let i = 0; i < hashes.length; i += 5) {
    const receipts = await Promise.all(hashes.slice(i, i + 5).map((hash) => pub.getTransactionReceipt({ hash })));
    for (const r of receipts) {
      const own = r.logs.filter((l) => l.address.toLowerCase() === vault.toLowerCase());
      events.push(...(parseEventLogs({ abi: policyVaultAbi, logs: own }) as unknown as ProofEvent[]));
    }
  }
  return events.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
}

async function vaultState(vault: Address, token: Address) {
  const read = (functionName: "heldTotal" | "protectedAmount" | "dailyCeiling" | "vaultSpentToday" | "frozen") =>
    pub.readContract({ address: vault, abi: policyVaultAbi, functionName });
  const [balance, held, protectedAmount, dailyCeiling, spent24h, frozen] = await Promise.all([
    pub.readContract({ address: token, abi: testUsdAbi, functionName: "balanceOf", args: [vault] }),
    read("heldTotal"),
    read("protectedAmount"),
    read("dailyCeiling"),
    read("vaultSpentToday"),
    read("frozen"),
  ]);
  return { balance, held, protectedAmount, dailyCeiling, spent24h, frozen } as {
    balance: bigint;
    held: bigint;
    protectedAmount: bigint;
    dailyCeiling: bigint;
    spent24h: bigint;
    frozen: boolean;
  };
}

/** Which contract a vault runs and its token, from the vault itself (a first-version vault has no VERSION). */
async function vaultInfo(vault: Address) {
  const [version, token] = await Promise.all([
    pub.readContract({ address: vault, abi: policyVaultAbi, functionName: "VERSION" }).then(Number, () => 1),
    pub.readContract({ address: vault, abi: policyVaultAbi, functionName: "token" }),
  ]);
  return { version, token: token as Address };
}

/** ?vault=0x… from the address bar, read once on load (any vault can be checked; nothing else is trusted from it). */
function useVaultParam() {
  const [param, setParam] = useState<Address | null | undefined>(undefined);
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("vault");
    setParam(raw && isAddress(raw, { strict: false }) ? getAddress(raw) : null);
  }, []);
  return [param, setParam] as const;
}

const dot: Record<ProofLine["tone"], string> = { good: "bg-green", bad: "bg-red", warn: "bg-amber", neutral: "bg-line" };

export default function ProofPage() {
  const router = useRouter();
  // Logged-out visitors have no vault of their own; they see the reference vault straight away.
  const { isAuthenticated, isLoading } = useConvexAuth();
  const signedIn = isAuthenticated ? {} : "skip";
  const statusQuery = useQuery(api.vault.status, signedIn);
  const chainStatus = isAuthenticated ? statusQuery : isLoading ? undefined : null;
  const agents = useQuery(api.agents.list, signedIn);
  const wallet = useQuery(api.wallet.get, signedIn);
  const [param, setParam] = useVaultParam();
  const w = chainStatus?.wallet;
  const own = w?.status === "live" && w.address ? (getAddress(w.address) as Address) : null;
  // A vault named in the link wins; then your own; then the judge account's, so a visitor always sees a real record.
  const vault = param ?? own ?? (getAddress(REFERENCE_VAULT) as Address);
  const mine = Boolean(own && vault === own);
  const [lines, setLines] = useState<ProofLine[] | null>(null);
  const [risk, setRisk] = useState<Exposure | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [riskError, setRiskError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  // Your own vault waits for your names; any other vault is read without them.
  const ready = param !== undefined && chainStatus !== undefined && (!mine || Boolean(agents && wallet));
  useEffect(() => {
    if (!ready) return;
    let stop = false;
    setLines(null);
    setRisk(null);
    setVersion(null);
    setLogError(null);
    setRiskError(null);
    const names =
      mine && agents && wallet
        ? {
            agents: Object.fromEntries(agents.filter((a) => a.chainAddress).map((a) => [a.chainAddress!.toLowerCase(), a.name])),
            contacts: contactLabels(wallet.payees.map((p) => ({ id: contactIdOf(p._id), name: p.name }))),
            addresses: addressLabels(wallet.payees),
          }
        : { agents: {}, contacts: {}, addresses: {} };
    const why = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0]!.slice(0, 160) : "Couldn't read Base Sepolia");
    // Read independently: a slow log scan shouldn't hide the exposure, or the other way round.
    vaultLog(vault, mine ? (w?.deployTx as Hex | undefined) : undefined).then(
      (events) => !stop && setLines(events.map((e) => describeEvent(e, names)).reverse()),
      (e) => !stop && setLogError(why(e)),
    );
    vaultInfo(vault)
      .then(async (info) => {
        if (stop) return;
        setVersion(info.version);
        if (!isVaultVersion(info.version)) return;
        const state = await vaultState(vault, info.token);
        if (!stop) setRisk(exposure(state));
      })
      .catch((e) => !stop && setRiskError(why(e)));
    return () => {
      stop = true;
    };
    // Re-read when the vault changes, not on every query tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault, ready, mine]);

  if (!ready) return <Skeleton className="mx-auto h-96 max-w-3xl rounded-card" />;
  const current = version === null || isVaultVersion(version);
  const reference = REFERENCE_VAULTS.find((r) => r.address.toLowerCase() === vault.toLowerCase());
  const explorer = w?.explorer ?? EXPLORER;
  const show = (address: string | null) => {
    setParam(address ? (getAddress(address) as Address) : null);
    router.replace(address ? `/proof?vault=${address}` : "/proof");
  };
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageTitle>Proof</PageTitle>

      <div className={cn("rounded-card p-4 text-label", mine ? "bg-green-soft text-green" : "bg-sky-soft text-navy")}>
        <div className="flex items-center gap-1.5 font-semibold">
          <Radio className="size-4" />
          {mine ? "Your vault, read live from Base Sepolia" : reference ? `Reference vault: ${reference.label}, read live from Base Sepolia` : "A vault, read live from Base Sepolia"}
        </div>
        <p className="mt-1 text-ink-2">
          {mine
            ? "Names come from your own contacts and agents."
            : reference
              ? `${reference.note} ${own ? "" : "Your own vault appears here once your wallet is on-chain (Wallet screen)."}`
              : "Names aren't shown for a vault that isn't yours; addresses and amounts come from the chain."}
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {own && (
            <button onClick={() => show(null)} className={cn("press rounded-full px-3 py-1 font-semibold", mine ? "bg-green text-white" : "bg-white text-navy")}>
              Your vault
            </button>
          )}
          {REFERENCE_VAULTS.map((r) => (
            <button
              key={r.address}
              onClick={() => show(r.address)}
              className={cn("press rounded-full px-3 py-1 font-semibold", r === reference && !mine ? "bg-navy text-white" : "bg-white text-navy")}
            >
              {r.label}
            </button>
          ))}
        </div>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (isAddress(typed.trim(), { strict: false })) show(typed.trim());
          }}
        >
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Any vault address, 0x…" aria-label="Vault address" className="num h-10 flex-1" spellCheck={false} autoCapitalize="off" />
          <Button type="submit" tone="outline" disabled={!isAddress(typed.trim(), { strict: false })}>
            Check
          </Button>
        </form>
      </div>

      <p className="text-label text-ink-2">
        Everything here is read in your browser from Base Sepolia, not from our server: each event is decoded from its transaction receipt (a public explorer index only finds which transactions to fetch). Amounts, refusal codes and times come from the chain. Test dollars (tUSD), no real value.
      </p>

      <Card title="If every agent key leaked right now">
        {risk ? (
          <>
            <dl className="grid grid-cols-3 gap-3 text-center">
              <div>
                <dt className="text-label text-mute">Could still move today</dt>
                <dd className="num text-title font-semibold">{usd(risk.now)}</dd>
              </div>
              <div>
                <dt className="text-label text-mute">Most in any 24 hours</dt>
                <dd className="num text-title font-semibold">{usd(risk.bound24h)}</dd>
              </div>
              <div>
                <dt className="text-label text-mute">Held, cancellable</dt>
                <dd className="num text-title font-semibold">{usd(risk.committed)}</dd>
              </div>
            </dl>
            <ul className="mt-3 list-disc space-y-0.5 pl-5 text-label text-ink-2">
              {risk.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </>
        ) : !current ? (
          <p className="text-label text-ink-2">This is a first-version vault without these limits.{mine ? " Move to the current vault on the Wallet screen to get them." : ""}</p>
        ) : riskError ? (
          <p className="text-label text-red">{riskError}</p>
        ) : (
          <Skeleton className="h-20 rounded-btn" />
        )}
      </Card>

      <Card
        title="Vault record"
        pad={false}
        action={
          <a href={`${explorer}/address/${vault}`} target="_blank" rel="noopener" className="flex items-center gap-1 pr-4 text-label font-semibold text-cyan-ink">
            {vault.slice(0, 10)}… <ExternalLink className="size-3" />
          </a>
        }
      >
        {lines === null ? (
          logError ? <p className="px-4 pb-4 text-label text-red">{logError}</p> : <Skeleton className="mx-4 mb-4 h-64 rounded-btn" />
        ) : lines.length === 0 ? (
          <Empty>No events yet.</Empty>
        ) : (
          <Divided className="px-4 pb-1">
            {lines.map((l) => (
              // Not the shared Row: proof lines wrap instead of truncating, the detail is the point.
              <div key={`${l.tx}-${l.index}`} className="flex items-start gap-3 py-2.5">
                <span className={cn("mt-1.5 size-2.5 shrink-0 rounded-full", dot[l.tone])} />
                <div className="min-w-0 flex-1">
                  <div className="text-body font-medium break-words text-ink">{l.title}</div>
                  {l.detail && <div className="text-label break-words text-mute">{l.detail}</div>}
                </div>
                <a href={`${explorer}/tx/${l.tx}`} target="_blank" rel="noopener" className="flex shrink-0 items-center gap-1 pt-0.5 text-label text-cyan-ink" aria-label={`Transaction in block ${l.block}`}>
                  <span className="hidden sm:inline">#{String(l.block)}</span> <ExternalLink className="size-3.5" />
                </a>
              </div>
            ))}
          </Divided>
        )}
      </Card>

      <Card title="Published test results">
        <ul className="space-y-1.5 text-label">
          {[
            ["Attack suite: hot wallet vs capped wallet vs this vault", `${REPO}/evals`],
            ["Contract tests (Foundry), including the review's adversarial cases", `${REPO}/contracts/test`],
            ["Backend tests against the production handlers", `${REPO}/packages/backend/convex`],
          ].map(([label, href]) => (
            <li key={href}>
              <a href={href} target="_blank" rel="noopener" className="flex items-center gap-1.5 text-cyan-ink">
                <ShieldCheck className="size-3.5" /> {label} <ExternalLink className="size-3" />
              </a>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
