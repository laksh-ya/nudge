"use client";

import { useMutation } from "convex/react";
import { Landmark, LoaderCircle, MessageCircle, Plug, Send, Users } from "lucide-react";
import type { PaymentState } from "@agent-wallet/domain";
import { api, type Id } from "@/lib/api";
import { approvalLink } from "@/lib/config";
import { cn } from "@/lib/cn";
import { Button, ButtonLink, Money, StateChip } from "./ui";

export type TaskView = {
  _id: Id<"tasks">;
  title: string;
  state: PaymentState;
  amountMinor?: number;
  currency?: "INR" | "CNY" | "USD" | "USDC" | "EUR" | "GBP";
  payee?: string;
  agent?: string;
  reason?: string;
  rail: "simulator" | "base-sepolia" | "handoff";
  channel: "app" | "telegram" | "whatsapp" | "mcp" | "family";
  approvalToken?: string;
};

const channelIcon = { app: MessageCircle, telegram: Send, whatsapp: MessageCircle, mcp: Plug, family: Users };
const channelLabel = { app: "App", telegram: "Telegram", whatsapp: "WhatsApp", mcp: "MCP", family: "Family" };

export function TaskCard({ task, className }: { task: TaskView; className?: string }) {
  const cancel = useMutation(api.tasks.cancel);
  const ChannelIcon = channelIcon[task.channel];
  const waiting = task.state === "awaiting_approval";
  return (
    <div className={cn("rounded-[14px] border border-line bg-white p-3.5", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-body font-semibold">{task.payee ?? task.title}</div>
          <div className="flex items-center gap-1.5 text-label text-mute">
            <ChannelIcon className="size-3" />
            {[task.agent, channelLabel[task.channel], task.rail === "handoff" ? "UPI" : task.currency === "USDC" ? "Wallet" : null]
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
          {task.state === "submitted" && <LoaderCircle className="size-3.5 animate-spin text-cyan" />}
          {task.rail === "handoff" && waiting && <Landmark className="size-3.5 text-mute" />}
        </div>
        {waiting && task.approvalToken && (
          <div className="flex gap-1.5">
            <Button size="sm" tone="ghost" onClick={() => cancel({ taskId: task._id })}>
              Cancel
            </Button>
            <ButtonLink size="sm" href={approvalLink(task.approvalToken)} external>
              Review
            </ButtonLink>
          </div>
        )}
      </div>
      {task.reason && (task.state === "failed" || task.state === "unknown") && (
        <p className="mt-2 text-label text-ink-2">{task.reason}</p>
      )}
    </div>
  );
}
