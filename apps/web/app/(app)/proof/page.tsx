"use client";

import { useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { createPublicClient, formatUnits, http, parseEventLogs, type Address, type Hex } from "viem";
import { ExternalLink, ShieldCheck } from "lucide-react";
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
import { Card, Divided, Empty, PageTitle, Skeleton } from "@/components/ui";

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
const REPO = "https://github.com/laksh-ya/agent-wallet/tree/main";

const usd = (units: bigint) => `$${Number(formatUnits(units, 6)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Which transactions touched the vault: the public node only answers 200-block log queries, so a
 * block explorer's index finds them. The explorer only points; every event shown is decoded from
 * the receipt fetched from Base Sepolia itself, keeping only logs the vault emitted.
 */
async function vaultTransactions(vault: Address, deployTx: Hex) {
  const hashes = new Set<Hex>([deployTx]);
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

async function vaultLog(vault: Address, deployTx: Hex) {
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

const dot: Record<ProofLine["tone"], string> = { good: "bg-green", bad: "bg-red", warn: "bg-amber", neutral: "bg-line" };

export default function ProofPage() {
  const chainStatus = useQuery(api.vault.status);
  const agents = useQuery(api.agents.list);
  const wallet = useQuery(api.wallet.get);
  const w = chainStatus?.wallet;
  const vault = w?.status === "live" && w.address ? (w.address as Address) : null;
  const [lines, setLines] = useState<ProofLine[] | null>(null);
  const [risk, setRisk] = useState<Exposure | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [riskError, setRiskError] = useState<string | null>(null);
  const current = isVaultVersion(w?.version);

  const ready = vault && w?.deployTx && w.tokenAddress && agents && wallet;
  useEffect(() => {
    if (!ready) return;
    let stop = false;
    const names = {
      agents: Object.fromEntries(agents.filter((a) => a.chainAddress).map((a) => [a.chainAddress!.toLowerCase(), a.name])),
      contacts: contactLabels(wallet.payees.map((p) => ({ id: contactIdOf(p._id), name: p.name }))),
      addresses: addressLabels(wallet.payees),
    };
    const why = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0]!.slice(0, 160) : "Couldn't read Base Sepolia");
    // Read independently: a slow log scan shouldn't hide the exposure, or the other way round.
    vaultLog(vault, w.deployTx as Hex).then(
      (events) => !stop && setLines(events.map((e) => describeEvent(e, names)).reverse()),
      (e) => !stop && setLogError(why(e)),
    );
    if (current) {
      vaultState(vault, w.tokenAddress as Address).then(
        (state) => !stop && setRisk(exposure(state)),
        (e) => !stop && setRiskError(why(e)),
      );
    }
    return () => {
      stop = true;
    };
    // Re-read when the vault changes, not on every query tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault, w?.deployTx, w?.tokenAddress, current, Boolean(agents), Boolean(wallet)]);

  if (chainStatus === undefined) return <Skeleton className="mx-auto h-96 max-w-3xl rounded-card" />;
  if (!vault) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageTitle>Proof</PageTitle>
        <Card>
          <Empty>Put your wallet on-chain (Wallet screen) and its record shows up here, read from Base Sepolia.</Empty>
        </Card>
      </div>
    );
  }
  const explorer = w?.explorer ?? "https://sepolia.basescan.org";
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageTitle>Proof</PageTitle>
      <p className="text-label text-ink-2">
        Everything here is read in your browser from Base Sepolia, not from our server: each event is decoded from its transaction receipt (a public explorer index only finds which transactions to fetch). Amounts, refusal codes and times come from the chain; names come from your own contacts and agents.
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
          <p className="text-label text-ink-2">This is a first-version vault without these limits. Move to the current vault on the Wallet screen to get them.</p>
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
