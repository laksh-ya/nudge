"use client";

import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { Check, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Card, Meter } from "./ui";

/** The persistent "finish setting up" list. Disappears once everything is done. */
export function SetupCard() {
  const state = useQuery(api.onboarding.state);
  const setStep = useMutation(api.onboarding.setStep);
  const router = useRouter();
  if (!state) return null;
  const items = [
    { step: "sources", label: "Add your accounts", done: state.counts.accounts > 0 },
    { step: "history", label: "Bring in history", done: state.counts.withHistory > 0 },
    { step: "review", label: "Review regular payments", done: state.counts.suggested === 0 && state.counts.confirmed > 0 },
    { step: "wallet", label: "Set up the agent wallet", done: Boolean(state.wallet) },
    { step: "chat", label: "Link Telegram", done: Boolean(state.chat?.linked) },
  ];
  const done = items.filter((i) => i.done).length;
  if (done === items.length) return null;
  return (
    <Card title="Finish setting up" action={<span className="num text-label font-semibold text-mute">{done} of {items.length}</span>}>
      <Meter value={done} max={items.length} tone="green" className="-mt-1 mb-2" />
      <div className="divide-y divide-line">
        {items.map((i) => (
          <button
            key={i.step}
            disabled={i.done}
            onClick={async () => {
              await setStep({ step: i.step });
              router.push("/onboarding");
            }}
            className="press flex w-full items-center gap-3 py-2.5 text-left disabled:active:scale-100"
          >
            <span className={cn("grid size-6 shrink-0 place-items-center rounded-full border", i.done ? "border-green bg-green text-white" : "border-line")}>
              {i.done && <Check className="size-3.5" strokeWidth={3} />}
            </span>
            <span className={cn("flex-1 text-body", i.done ? "text-mute line-through" : "font-medium")}>{i.label}</span>
            {!i.done && <ChevronRight className="size-4 text-mute" />}
          </button>
        ))}
      </div>
    </Card>
  );
}
