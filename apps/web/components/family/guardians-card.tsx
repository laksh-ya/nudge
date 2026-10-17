"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import Link from "next/link";
import { ShieldCheck, UserPlus, X } from "lucide-react";
import { api } from "@/lib/api";
import { approvalLink } from "@/lib/config";
import { Initial } from "@/components/brand";
import { errorMessage } from "@/components/form";
import { Button, Card, Chip, Divided, Row } from "@/components/ui";

const message = errorMessage;

/**
 * The owner's side: invite someone they trust to watch held payments and stop them, remove them at
 * once, and make every assistant payment wait longer so there is time to look.
 */
export function GuardiansCard() {
  const data = useQuery(api.guardians.list);
  const invite = useMutation(api.guardians.invite);
  const remove = useMutation(api.guardians.remove);
  const protectMore = useMutation(api.guardians.protectMore);
  const [name, setName] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  if (!data) return null;
  return (
    <Card
      title="Guardians"
      action={
        data.protecting.length > 0 ? (
          <Link href="/guardian" className="text-label font-semibold text-cyan">
            People you look after
          </Link>
        ) : undefined
      }
    >
      <p className="text-body text-ink-2">
        Someone you trust sees payments your assistants make that are on hold, and can stop them before they leave. They can't pay, approve or change your limits, and you can remove them at any time.
      </p>
      {data.guardians.length > 0 && (
        <Divided className="mt-2">
          {data.guardians.map((g) => (
            <Row
              key={g._id}
              leading={<Initial name={g.name} size={40} />}
              title={g.name}
              sub={
                g.status === "active"
                  ? `Signed in as ${g.account?.name ?? "their own account"}${g.account?.email ? ` · ${g.account.email}` : ""} · can stop held payments and freeze assistants`
                  : g.code
                    ? `Invited · code ${g.code} · only works once, for 24 hours`
                    : "Invite expired"
              }
              trailing={
                <button aria-label={`Remove ${g.name}`} className="press grid size-9 place-items-center rounded-full text-mute hover:bg-page" onClick={() => remove({ linkId: g._id })}>
                  <X className="size-4" />
                </button>
              }
            />
          ))}
        </Divided>
      )}
      {code ? (
        <div className="mt-3 rounded-[12px] bg-page p-3">
          <div className="text-label text-mute">Send them this code. It works once, for 24 hours. They open Guardian in their own account and enter it.</div>
          <div className="num mt-1 text-[24px] font-bold tracking-[0.2em] text-navy">{code}</div>
          <div className="mt-1 text-label text-mute">{typeof window !== "undefined" ? `${window.location.origin}/guardian?code=${code}` : ""}</div>
        </div>
      ) : (
        <form
          className="mt-3 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(undefined);
            try {
              setCode(await invite({ name }));
              setName("");
            } catch (err) {
              setError(message(err));
            }
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Their name, e.g. Priya (daughter)" maxLength={40} className="h-11 min-w-0 flex-1 rounded-btn border border-line px-3 text-body" />
          <Button type="submit" icon={UserPlus} disabled={!name.trim()}>
            Invite
          </Button>
        </form>
      )}
      <div className="mt-4 flex items-start gap-3 rounded-[12px] border border-line p-3">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-cyan" />
        <div className="flex-1">
          <div className="text-body font-semibold">Extra protection</div>
          <div className="text-label text-mute">
            Every assistant payment waits before it leaves, so you or your guardian can stop it.{" "}
            {data.holdMinutes !== null && <Chip tone="neutral">now {data.holdMinutes} min, above your hold amount</Chip>}
          </div>
          <div className="mt-2 flex gap-2">
            {([10, 30, 60] as const).map((m) => (
              <Button
                key={m}
                size="sm"
                tone="outline"
                onClick={async () => {
                  setError(undefined);
                  try {
                    window.location.assign(approvalLink(await protectMore({ holdMinutes: m })));
                  } catch (err) {
                    setError(message(err));
                  }
                }}
              >
                Hold {m} min
              </Button>
            ))}
          </div>
        </div>
      </div>
      {error && <p className="mt-2 text-label text-red">{error}</p>}
    </Card>
  );
}
