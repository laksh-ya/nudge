"use client";

import { LoaderCircle, ShieldCheck, TriangleAlert } from "lucide-react";
import { formatMoney, type Currency, type SourceKind } from "@agent-wallet/domain";
import { cn } from "@/lib/cn";
import { ago } from "@/lib/format";
import { Chip, IconTile, Row } from "../ui";
import { KIND_META } from "./add-source";

export type AccountView = {
  _id: string;
  kind: SourceKind;
  name: string;
  institution: string;
  currency: Currency;
  balanceMinor: number;
  syncedAt: number;
  source: "sandbox" | "statement" | "onchain" | "manual";
  status?: "ok" | "syncing" | "empty" | "error";
  statusNote?: string;
  last4?: string;
  network?: string;
  verified?: boolean;
  address?: string;
  transactions?: number;
  holdings?: { asset: string; chain: string; amount: number; usdMinor: number }[];
};

const sourceLabel = { sandbox: "Connected · sandbox", statement: "Statements", onchain: "On-chain", manual: "Manual" };

export function AccountRow({ account: a, href, onClick, hideBalance }: { account: AccountView; href?: string; onClick?: () => void; hideBalance?: boolean }) {
  const syncing = a.status === "syncing";
  const sub = [
    a.last4 ? `${a.network ?? ""} •• ${a.last4}`.trim() : a.address ? `${a.address.slice(0, 6)}…${a.address.slice(-4)}` : a.institution !== a.name ? a.institution : null,
    syncing ? "Syncing" : a.status === "empty" ? "No history yet" : a.status === "error" ? a.statusNote ?? "Couldn't sync" : `${sourceLabel[a.source]} · ${ago(a.syncedAt)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Row
      href={href}
      onClick={onClick}
      leading={<IconTile icon={KIND_META[a.kind].icon} tone={a.status === "error" ? "red" : a.status === "empty" ? "page" : "sky"} />}
      title={
        <span className="flex items-center gap-1.5">
          <span className="truncate">{a.name}</span>
          {a.verified && <ShieldCheck className="size-3.5 shrink-0 text-green" aria-label="Ownership proved" />}
        </span>
      }
      sub={sub}
      trailing={
        syncing ? (
          <LoaderCircle className="size-4 animate-spin text-cyan" />
        ) : a.status === "error" ? (
          <TriangleAlert className="size-4 text-red" />
        ) : a.status === "empty" ? (
          <Chip>Add history</Chip>
        ) : (
          <span className={cn("num text-body font-semibold", a.balanceMinor < 0 && "text-red")}>
            {hideBalance ? "••••" : formatMoney(a.balanceMinor, a.currency)}
          </span>
        )
      }
    />
  );
}
