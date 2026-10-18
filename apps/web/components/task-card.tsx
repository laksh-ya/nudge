"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { ExternalLink, Landmark, LoaderCircle, MessageCircle, Plug, Send, Users } from "lucide-react";
import type { Currency, PaymentState } from "@agent-wallet/domain";
import { api, type Id } from "@/lib/api";
import { approvalLink } from "@/lib/config";
import { cn } from "@/lib/cn";
import { formatMoney } from "@/lib/format";
import { Button, ButtonLink, Money, Sheet, StateChip } from "./ui";

export type TaskView = {
  _id: Id<"tasks">;
  title: string;
  state: PaymentState;
  amountMinor?: number;
  currency?: Currency;
  payee?: string;
  agent?: string;
  reason?: string;
  purpose?: string;
  rail: "simulator" | "base-sepolia" | "handoff";
  channel: "app" | "telegram" | "whatsapp" | "mcp" | "family";
  approvalToken?: string;
  txHash?: string;
  sample?: boolean;
};

const channelIcon = { app: MessageCircle, telegram: Send, whatsapp: MessageCircle, mcp: Plug, family: Users };
const channelLabel = { app: "App", telegram: "Telegram", whatsapp: "WhatsApp", mcp: "MCP", family: "Family" };

export function TaskCard({ task, className }: { task: TaskView; className?: string }) {
  const cancel = useMutation(api.tasks.cancel);
  const decide = useMutation(api.approvals.decide);
  const ChannelIcon = channelIcon[task.channel];
  const waiting = task.state === "awaiting_approval";
  const [confirming, setConfirming] = useState(false);
  const amount = task.amountMinor !== undefined ? formatMoney(task.amountMinor, task.currency ?? "USDC") : "";
  return (
    <div className={cn("rounded-[14px] border border-line bg-white p-3.5", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-body font-semibold">{task.payee ?? task.title}</div>
          <div className="flex items-center gap-1.5 text-label text-mute">
            <ChannelIcon className="size-3" />
            {[task.sample ? "Sample" : null, task.agent, channelLabel[task.channel], task.rail === "handoff" ? "UPI" : task.currency === "USDC" ? "Wallet" : null]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        {task.amountMinor !== undefined && (
          <Money minor={task.amountMinor} currency={task.currency ?? "USDC"} className="figure text-title" />
        )}
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <StateChip state={task.state} />
          {task.rail === "simulator" && task.state === "confirmed" && <span className="text-micro text-mute">Simulated</span>}
          {task.rail === "base-sepolia" && <span className="text-micro text-mute">On-chain</span>}
          {(task.state === "submitted" || task.state === "reserved") && <LoaderCircle className="size-3.5 animate-spin text-cyan" />}
          {task.rail === "handoff" && waiting && <Landmark className="size-3.5 text-mute" />}
        </div>
        {waiting && task.approvalToken && (
          <div className="flex gap-1.5">
            <Button size="sm" tone="ghost" onClick={() => cancel({ taskId: task._id })}>
              Cancel
            </Button>
            {task.rail === "base-sepolia" ? (
              // The vault needs the owner's passkey, which lives on the approval site.
              <ButtonLink size="sm" href={approvalLink(task.approvalToken)} external>
                Review
              </ButtonLink>
            ) : task.rail === "handoff" ? (
              <>
                <ButtonLink size="sm" tone="ghost" href={approvalLink(task.approvalToken)} external>
                  Review
                </ButtonLink>
                <Button size="sm" onClick={() => decide({ token: task.approvalToken!, approve: true })}>
                  I paid
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => setConfirming(true)}>
                Approve
              </Button>
            )}
          </div>
        )}
      </div>
      {task.reason && (task.state === "failed" || task.state === "unknown" || waiting) && (
        <p className="mt-2 text-label text-ink-2">{waiting ? `Why you're asked: ${task.reason}` : task.reason}</p>
      )}
      {waiting && task.purpose && task.agent && (
        // The assistant wrote this; nothing checks it.
        <p className="mt-1.5 line-clamp-2 rounded-md bg-page px-2 py-1 text-label break-words text-ink-2">
          <span className="font-semibold text-mute">Note from {task.agent} · not verified: </span>
          {task.purpose}
        </p>
      )}
      <Sheet open={confirming} onOpenChange={setConfirming} title={amount ? `Approve ${amount} to ${task.payee ?? task.title}?` : `${task.title}?`}>
        <p className="text-body text-ink-2">
          {amount
            ? "Simulated approval: this wallet has no passkey yet, so nothing on-chain checks it. Put the wallet on-chain (Wallet screen) to approve with your passkey instead."
            : `${task.agent ? `${task.agent} asked for this. ` : ""}Approving changes what it may do on its own. Your wallet is simulated, so this is your yes instead of a passkey.`}
        </p>
        <div className="mt-5 mb-4 grid grid-cols-2 gap-2">
          <Button tone="outline" size="lg" onClick={() => setConfirming(false)}>
            Not now
          </Button>
          <Button
            size="lg"
            onClick={async () => {
              setConfirming(false);
              await decide({ token: task.approvalToken!, approve: true });
            }}
          >
            Approve
          </Button>
        </div>
      </Sheet>
      {task.txHash && (
        <a href={`https://sepolia.basescan.org/tx/${task.txHash}`} target="_blank" rel="noopener" className="mt-2 inline-flex items-center gap-1 text-label font-semibold text-cyan-ink">
          {task.state === "failed" ? "Refusal on-chain" : "View transaction"} <ExternalLink className="size-3" />
        </a>
      )}
    </div>
  );
}
