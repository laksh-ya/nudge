"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Send } from "lucide-react";
import { api, type Id } from "@/lib/api";
import { cn } from "@/lib/cn";
import { time } from "@/lib/format";
import { Wordmark } from "@/components/brand";
import { TaskCard } from "@/components/task-card";
import { Skeleton } from "@/components/ui";

const SUGGESTIONS = ["What can I spend?", "Bills due", "Pay rent", "My subscriptions", "Send Ananya ₹500", "Freeze my agents"];

export default function Assistant() {
  const messages = useQuery(api.messages.list);
  const send = useMutation(api.messages.send).withOptimisticUpdate((store, { text }) => {
    const current = store.getQuery(api.messages.list, {});
    if (!current) return;
    store.setQuery(api.messages.list, {}, [
      ...current,
      {
        _id: `optimistic-${Date.now()}` as Id<"messages">,
        _creationTime: Date.now(),
        userId: current[0]?.userId as Id<"users">,
        role: "user",
        text,
        channel: "app",
        task: null,
      },
    ]);
  });
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const waiting = messages?.at(-1)?.role === "user";

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: messages && messages.length > 0 ? "smooth" : "auto" });
  }, [messages?.length, waiting]);

  const submit = (value: string) => {
    const v = value.trim();
    if (!v) return;
    setText("");
    void send({ text: v });
    input.current?.focus();
  };

  return (
    <div className="-mx-4 -mt-4 flex h-[calc(100dvh-56px-var(--bar,0px))] flex-col lg:mx-0 lg:mt-0 lg:h-[calc(100dvh-64px-var(--bar,0px))] lg:overflow-hidden lg:rounded-card lg:bg-white lg:shadow-[var(--shadow-card)]">
      <div className="hidden items-center justify-between border-b border-line px-5 py-3.5 lg:flex">
        <h1 className="text-title font-semibold">Assistant</h1>
        <span className="flex items-center gap-1.5 text-label text-mute">
          <Send className="size-3.5" /> Same thread in Telegram
        </span>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4 lg:px-6">
        {messages === undefined ? (
          <div className="space-y-3">
            <Skeleton className="ml-auto h-10 w-48 rounded-2xl" />
            <Skeleton className="h-20 w-72 rounded-2xl" />
            <Skeleton className="ml-auto h-10 w-56 rounded-2xl" />
          </div>
        ) : messages.length === 0 ? (
          <div className="grid h-full place-items-center text-center">
            <div>
              <Wordmark className="text-[24px]" />
              <p className="mt-2 text-body text-mute">Ask about your money, or tell me what to pay.</p>
            </div>
          </div>
        ) : (
          messages.map((m, i) => {
            const mine = m.role === "user";
            const prev = messages[i - 1];
            const showChannel = m.channel !== "app" && prev?.channel !== m.channel;
            return (
              <div key={m._id} className={cn("rise flex flex-col", mine ? "items-end" : "items-start")}>
                {showChannel && (
                  <div className="mb-2 flex w-full items-center gap-2 text-micro font-semibold text-mute uppercase">
                    <span className="h-px flex-1 bg-line" />
                    {{ telegram: "From Telegram", whatsapp: "From WhatsApp", mcp: "From connected assistants", family: "From family", app: "" }[m.channel]}
                    <span className="h-px flex-1 bg-line" />
                  </div>
                )}
                <div
                  className={cn(
                    "max-w-[82%] rounded-[18px] px-3.5 py-2 text-body whitespace-pre-line lg:max-w-[70%]",
                    mine ? "rounded-br-[6px] bg-navy text-white" : "rounded-bl-[6px] bg-white text-ink shadow-[var(--shadow-card)] lg:bg-page lg:shadow-none",
                  )}
                >
                  {m.text}
                </div>
                {m.task && <TaskCard task={m.task} className="mt-2 w-[min(100%,340px)]" />}
                <span className="mt-1 px-1 text-micro text-mute">{time(m._creationTime)}</span>
              </div>
            );
          })
        )}
        {waiting && (
          <div className="flex gap-1 rounded-[18px] rounded-bl-[6px] bg-white px-4 py-3 shadow-[var(--shadow-card)] w-fit lg:bg-page lg:shadow-none" aria-label="Assistant is replying">
            {[0, 1, 2].map((d) => (
              <span key={d} className="size-1.5 rounded-full bg-mute" style={{ animation: `blink 1s ${d * 0.15}s infinite` }} />
            ))}
          </div>
        )}
        <div ref={end} />
      </div>

      <div className="pb-safe border-t border-line bg-white px-3 pt-2 lg:px-5">
        <div className="-mx-3 mb-2 flex gap-2 overflow-x-auto px-3 [scrollbar-width:none] lg:mx-0 lg:px-0">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => submit(s)}
              className="press h-8 shrink-0 rounded-btn border border-line bg-white px-3 text-label font-semibold text-navy hover:bg-sky-soft"
            >
              {s}
            </button>
          ))}
        </div>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit(text);
          }}
        >
          <input
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Message"
            className="h-11 flex-1 rounded-full border border-line bg-page px-4 text-[16px] outline-none placeholder:text-mute focus:border-cyan focus:bg-white"
            enterKeyHint="send"
            autoComplete="off"
          />
          <button
            type="submit"
            disabled={!text.trim()}
            aria-label="Send"
            className="press grid size-11 shrink-0 place-items-center rounded-full bg-cyan text-white disabled:bg-line disabled:text-mute"
          >
            <ArrowUp className="size-5" strokeWidth={2.5} />
          </button>
        </form>
      </div>
    </div>
  );
}
