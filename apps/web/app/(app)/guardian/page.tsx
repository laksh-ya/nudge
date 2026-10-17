"use client";

import { useMutation, useQuery } from "convex/react";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Clock, Snowflake } from "lucide-react";
import { api, type Id } from "@/lib/api";
import { countdown, useNow } from "@/lib/use-now";
import { Initial } from "@/components/brand";
import { errorMessage } from "@/components/form";
import { Button, Card, Chip, Divided, PageTitle, Row, Skeleton } from "@/components/ui";

const message = errorMessage;

/**
 * The guardian's side: for each person they look after, payments on hold (with a stop button),
 * what their assistants are asking for, and a freeze. No balances, no statements.
 */
export default function GuardianPage() {
  // The invite code can arrive in the link (?code=), which Next reads only inside a Suspense boundary.
  return (
    <Suspense>
      <Guardian />
    </Suspense>
  );
}

function Guardian() {
  const data = useQuery(api.guardians.list);
  const accept = useMutation(api.guardians.accept);
  const params = useSearchParams();
  const [code, setCode] = useState(params.get("code") ?? "");
  const [note, setNote] = useState<string>();
  useEffect(() => setCode(params.get("code") ?? ""), [params]);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageTitle>Guardian</PageTitle>
      <Card title="Look after someone">
        <p className="text-body text-ink-2">Enter the code they gave you. You'll see payments their assistants make that are on hold, and you can stop them. You can't pay, approve or change anything else.</p>
        <form
          className="mt-3 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setNote(undefined);
            try {
              const r = await accept({ code });
              setNote(`You're now looking after ${r.ownerName}.`);
              setCode("");
            } catch (err) {
              setNote(message(err));
            }
          }}
        >
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="8-letter code" maxLength={8} className="num h-11 min-w-0 flex-1 rounded-btn border border-line px-3 text-body tracking-[0.15em]" />
          <Button type="submit" disabled={code.trim().length !== 8}>
            Accept
          </Button>
        </form>
        {note && <p className="mt-2 text-label text-ink-2">{note}</p>}
      </Card>
      {data === undefined ? <Skeleton className="h-48 rounded-card" /> : data?.protecting.map((p) => <Person key={p.linkId} ownerId={p.ownerId} />)}
    </div>
  );
}

function Person({ ownerId }: { ownerId: Id<"users"> }) {
  const view = useQuery(api.guardians.watch, { ownerId });
  const cancel = useMutation(api.guardians.cancelHeld);
  const freeze = useMutation(api.guardians.freeze);
  const now = useNow();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  if (view === undefined) return <Skeleton className="h-48 rounded-card" />;
  if (view === null) return null;
  const anyActive = view.assistants.some((a) => a.status === "active");
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Initial name={view.ownerName} size={28} /> {view.ownerName}
        </span>
      }
      action={
        <Button
          size="sm"
          tone="outline"
          icon={Snowflake}
          disabled={!anyActive || busy === "freeze"}
          onClick={async () => {
            setBusy("freeze");
            try {
              await freeze({ ownerId });
            } catch (e) {
              setError(message(e));
            }
            setBusy(null);
          }}
        >
          {anyActive ? "Freeze their assistants" : "Assistants frozen"}
        </Button>
      }
    >
      {view.held.length === 0 ? (
        <p className="text-body text-ink-2">Nothing on hold right now.</p>
      ) : (
        <div className="space-y-2">
          {view.held.map((h) => (
            <div key={h.taskId} className="rounded-[12px] border-l-4 border-amber bg-page p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-body font-semibold">
                    {h.agent} is paying {h.payee} {h.amount}
                  </div>
                  <div className="text-label text-mute">On hold so it can be stopped</div>
                </div>
                {h.releaseAt && (
                  <Chip tone="amber">
                    <Clock className="size-3" />
                    <span className="num">{countdown(h.releaseAt, now)}</span>
                  </Chip>
                )}
              </div>
              <Button
                className="mt-3 w-full"
                tone="danger"
                disabled={busy === h.taskId}
                onClick={async () => {
                  setBusy(h.taskId);
                  try {
                    await cancel({ taskId: h.taskId });
                  } catch (e) {
                    setError(message(e));
                  }
                  setBusy(null);
                }}
              >
                Stop this payment
              </Button>
            </div>
          ))}
        </div>
      )}
      {view.asking.length > 0 && (
        <>
          <div className="mt-4 text-label font-semibold text-mute">Asking {view.ownerName} to approve</div>
          <Divided>
            {view.asking.map((a) => (
              <Row key={a.taskId} title={`${a.agent} → ${a.payee}`} sub="Only they can approve, with their passkey" trailing={<span className="num text-body">{a.amount}</span>} />
            ))}
          </Divided>
        </>
      )}
      {view.recent.length > 0 && (
        <>
          <div className="mt-4 text-label font-semibold text-mute">Recent</div>
          <Divided>
            {view.recent.map((r) => (
              <Row key={r.taskId} title={`${r.agent} → ${r.payee}`} sub={r.state === "confirmed" ? "Paid" : r.state === "cancelled" ? "Stopped" : "Not sent"} trailing={<span className="num text-body">{r.amount}</span>} />
            ))}
          </Divided>
        </>
      )}
      {error && <p className="mt-2 text-label text-red">{error}</p>}
    </Card>
  );
}
