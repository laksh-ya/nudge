"use client";

import { useAction, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, Camera, ExternalLink, FileSpreadsheet, LoaderCircle, PenLine, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { CAPABILITY_LABEL, CHAINS, formatMoney } from "@agent-wallet/domain";
import { api, type Id } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ago, fmtAmount, relativeDay } from "@/lib/format";
import { KIND_META } from "@/components/connect/add-source";
import { HistorySheet, type HistoryMode } from "@/components/connect/history-sheet";
import { Initials } from "@/components/money/initials";
import { TransactionSheet } from "@/components/money/transaction-sheet";
import { ErrorText, errorMessage } from "@/components/form";
import { Button, Card, Chip, Divided, IconTile, Money, Row, Sheet, Skeleton } from "@/components/ui";

const importLabel = { csv: "CSV", xlsx: "Excel", pdf: "PDF", scan: "Scan", sandbox: "Sandbox feed", manual: "Added by hand" };

export default function AccountPage() {
  const { id } = useParams<{ id: string }>();
  const accountId = id as Id<"accounts">;
  const data = useQuery(api.connections.get, { accountId });
  const reconnect = useMutation(api.connections.reconnect);
  const remove = useMutation(api.connections.remove);
  const verify = useAction(api.crypto.verifyOwnership);
  const router = useRouter();
  const [mode, setMode] = useState<HistoryMode | null>(null);
  const [open, setOpen] = useState<Id<"transactions"> | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string>();
  const [proving, setProving] = useState(false);
  const { results, status, loadMore } = usePaginatedQuery(api.money.transactions, { accountId }, { initialNumItems: 25 });

  if (data === undefined) return <Skeleton className="mx-auto h-64 max-w-3xl rounded-card" />;
  if (data === null) {
    return (
      <div className="mx-auto max-w-3xl">
        <Card>
          <p className="py-4 text-center text-body text-mute">This account isn't here any more.</p>
        </Card>
      </div>
    );
  }
  const { account: a, imports, holdings } = data;
  const meta = KIND_META[a.kind];
  const evm = a.chain === "evm";

  async function prove() {
    setError(undefined);
    if (!window.ethereum) return setError("Open this page in a browser with your wallet extension.");
    setProving(true);
    try {
      const [addr] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
      if (addr?.toLowerCase() !== a.address?.toLowerCase()) throw new Error("Switch your wallet to this address first");
      const message = `Nudge ownership check\nAccount: ${a._id}\nAddress: ${a.address}\nIssued at: ${Date.now()}\nThis signature does not move any funds.`;
      const signature = (await window.ethereum.request({ method: "personal_sign", params: [message, addr] })) as string;
      await verify({ accountId: a._id, message, signature });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setProving(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href="/money?tab=accounts" className="press inline-flex items-center gap-1 text-label font-semibold text-cyan-ink">
        <ArrowLeft className="size-3.5" /> Accounts
      </Link>

      <Card>
        <div className="flex items-start gap-3">
          <IconTile icon={meta.icon} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h1 className="truncate text-head font-semibold">{a.name}</h1>
              {a.verified && <ShieldCheck className="size-4 shrink-0 text-green" aria-label="Ownership proved" />}
            </div>
            <div className="text-label text-mute">
              {[a.institution !== a.name ? a.institution : null, a.last4 ? `${a.network ?? ""} •• ${a.last4}` : null, a.expiry ? `exp ${a.expiry}` : null, meta.label]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
        </div>
        <div className="mt-4 flex items-end justify-between gap-3">
          <div>
            <div className={cn("figure text-hero", a.balanceMinor < 0 && "text-red")}>
              {a.status === "syncing" ? <LoaderCircle className="size-8 animate-spin text-cyan" /> : formatMoney(a.balanceMinor, a.currency)}
            </div>
            <div className="text-label text-mute">
              {a.status === "error" ? a.statusNote : `Updated ${ago(a.syncedAt)}`}
              {a.kind === "crypto" ? " · valued in USD" : ""}
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {a.can.map((c) => (
            <Chip key={c} tone="cyan">
              {CAPABILITY_LABEL[c]}
            </Chip>
          ))}
          {a.uses?.map((u) => (
            <Chip key={u}>{u}</Chip>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-3 gap-2">
        {a.kind !== "crypto" && (
          <>
            {a.source === "sandbox" ? (
              <Action icon={RefreshCw} label="Sync again" onClick={() => reconnect({ accountId })} />
            ) : (
              <Action icon={FileSpreadsheet} label="Statement" onClick={() => setMode("statement")} />
            )}
            <Action icon={Camera} label="Scan" onClick={() => setMode("scan")} />
            <Action icon={PenLine} label="By hand" onClick={() => setMode("manual")} />
          </>
        )}
        {a.kind === "crypto" && a.source === "onchain" && (
          <>
            <Action icon={RefreshCw} label="Refresh" onClick={() => reconnect({ accountId })} />
            {evm && !a.verified && <Action icon={ShieldCheck} label={proving ? "Signing" : "Prove it's mine"} onClick={prove} />}
            {a.address && (
              <a
                href={`${(CHAINS.find((c) => c.family === a.chain && !c.testnet) ?? CHAINS[0]!).explorer}${a.address}`}
                target="_blank"
                rel="noopener"
                className="press flex h-16 flex-col items-center justify-center gap-1 rounded-[12px] bg-white text-label font-semibold text-navy shadow-[var(--shadow-card)]"
              >
                <ExternalLink className="size-5" strokeWidth={1.9} />
                Explorer
              </a>
            )}
          </>
        )}
        {a.kind === "crypto" && a.source !== "onchain" && <Action icon={FileSpreadsheet} label="Statement" onClick={() => setMode("statement")} />}
      </div>
      <ErrorText>{error}</ErrorText>

      {holdings.length > 0 && (
        <Card title="Holdings" pad={false}>
          <Divided className="px-4 pb-1">
            {holdings.map((h) => (
              <Row
                key={h._id}
                leading={<Initials name={h.asset} />}
                title={`${fmtAmount(h.amount)} ${h.asset}`}
                sub={CHAINS.find((c) => c.id === h.chain)?.name ?? h.chain}
                trailing={<span className="num text-body font-semibold">{h.usdMinor ? formatMoney(h.usdMinor, "USD") : "Test asset"}</span>}
              />
            ))}
          </Divided>
        </Card>
      )}

      {a.kind !== "crypto" || a.source !== "onchain" ? (
        <Card title="Transactions" pad={false}>
          {status === "LoadingFirstPage" ? (
            <Skeleton className="m-4 h-40" />
          ) : results.length === 0 ? (
            <p className="px-4 pb-5 text-body text-mute">No history yet. Add a statement, scan a passbook, or type one in.</p>
          ) : (
            <Divided className="px-4 pb-1">
              {results.map((t) => (
                <Row
                  key={t._id}
                  onClick={() => setOpen(t._id)}
                  className={cn(t.duplicateOf && "opacity-50")}
                  leading={<Initials name={t.merchant} />}
                  title={t.merchant}
                  sub={`${relativeDay(t.at)} · ${t.category}${t.duplicateOf ? " · counted once" : ""}`}
                  trailing={<Money minor={t.amountMinor} currency={t.currency} sign className={cn("text-body font-semibold", t.amountMinor > 0 && "text-green")} />}
                />
              ))}
            </Divided>
          )}
          {status === "CanLoadMore" && (
            <div className="px-3 pb-3">
              <Button tone="ghost" className="w-full" onClick={() => loadMore(25)}>
                Show more
              </Button>
            </div>
          )}
        </Card>
      ) : null}

      {imports.length > 0 && (
        <Card title="Imports" pad={false}>
          <Divided className="px-4 pb-1">
            {imports.map((i) => (
              <Row
                key={i._id}
                leading={<IconTile icon={i.kind === "scan" ? Camera : FileSpreadsheet} tone="page" />}
                title={i.fileName ?? importLabel[i.kind]}
                sub={`${importLabel[i.kind]} · ${ago(i._creationTime)}`}
                trailing={
                  <div className="text-right text-label">
                    <div className="font-semibold">{i.added} added</div>
                    {(i.duplicates > 0 || i.transfers > 0) && (
                      <div className="text-mute">{[i.duplicates ? `${i.duplicates} known` : null, i.transfers ? `${i.transfers} transfers` : null].filter(Boolean).join(" · ")}</div>
                    )}
                  </div>
                }
              />
            ))}
          </Divided>
        </Card>
      )}

      <Button tone="danger" icon={Trash2} className="w-full" onClick={() => setConfirm(true)}>
        Remove account
      </Button>

      {mode && <HistorySheet open onOpenChange={(o) => !o && setMode(null)} account={a} mode={mode} />}
      <TransactionSheet id={open} onClose={() => setOpen(null)} />
      <Sheet open={confirm} onOpenChange={setConfirm} title={`Remove ${a.name}?`}>
        <p className="text-body text-ink-2">Its balance and imported transactions are deleted from this app. Nothing changes at your bank or wallet.</p>
        <div className="mt-5 mb-2 grid grid-cols-2 gap-2">
          <Button tone="outline" size="lg" onClick={() => setConfirm(false)}>
            Keep
          </Button>
          <Button
            tone="danger"
            size="lg"
            onClick={async () => {
              await remove({ accountId });
              router.replace("/money?tab=accounts");
            }}
          >
            Remove
          </Button>
        </div>
      </Sheet>
    </div>
  );
}

function Action({ icon: Icon, label, onClick }: { icon: typeof Camera; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="press flex h-16 flex-col items-center justify-center gap-1 rounded-[12px] bg-white text-label font-semibold text-navy shadow-[var(--shadow-card)] hover:bg-sky-soft">
      <Icon className="size-5" strokeWidth={1.9} />
      {label}
    </button>
  );
}
