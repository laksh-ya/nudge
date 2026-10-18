"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Check, Copy, HandCoins, HeartHandshake, Link2, Plus, Send, Settings2, ShieldCheck, Trash2, UserPlus } from "lucide-react";
import { api, type Id } from "@/lib/api";
import { approvalLink } from "@/lib/config";
import { formatMoney } from "@/lib/format";
import { Initial } from "@/components/brand";
import { Button, Card, Chip, Divided, Empty, Meter, PageTitle, Row, Sheet, Skeleton } from "@/components/ui";
import { ErrorText, Field, Input, MoneyInput, Select, Toggle, errorMessage, toMinorUnits } from "@/components/form";
import { GuardiansCard } from "@/components/family/guardians-card";

type Data = NonNullable<ReturnType<typeof useQuery<typeof api.circle.mine>>>;
type Member = Data["members"][number];

const usd = (n: number) => formatMoney(n, "USDC");
const when = (at: number) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/**
 * Family: the people you support (invite by link; they join with their own Nudge account), what
 * they may get without asking, and what they ask for. If someone supports you, you ask them here.
 */
export default function FamilyPage() {
  const data = useQuery(api.circle.mine);
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [sending, setSending] = useState<Member | null>(null);
  if (data === undefined) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <PageTitle>Family</PageTitle>
        <Skeleton className="h-40 rounded-card" />
        <Skeleton className="h-64 rounded-card" />
      </div>
    );
  }
  if (data === null) return null;
  const needsYou = data.asks.filter((a) => a.state === "approval");
  const history = data.asks.filter((a) => a.state === "paid" || a.state === "declined");
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageTitle
        action={
          <Button size="sm" icon={UserPlus} onClick={() => setInviting(true)}>
            Invite
          </Button>
        }
      >
        Family
      </PageTitle>

      {data.supporters.map((s) => (
        <SupportedBy key={s.linkId} s={s} myAsks={data.myAsks.filter((a) => a.linkId === s.linkId)} />
      ))}

      {needsYou.length > 0 && (
        <Card title={`Asking you · ${needsYou.length}`} className="border-l-4 border-amber">
          <Divided>
            {needsYou.map((a) => (
              <AskRow key={a._id} ask={a} />
            ))}
          </Divided>
        </Card>
      )}

      <Card title="People you support" pad={false}>
        {data.members.length === 0 ? (
          <div className="px-4 pb-4">
            <Empty>
              Invite your child, partner or parents. They join with their own Nudge account, get an allowance you set, and ask you for more from their phone.
            </Empty>
            <Button className="w-full" icon={UserPlus} onClick={() => setInviting(true)}>
              Invite someone
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-line">
            {data.members.map((m) => (
              <MemberRow key={m._id} m={m} onEdit={() => setEditing(m)} onSend={() => setSending(m)} />
            ))}
          </div>
        )}
      </Card>

      <GuardiansCard />

      {history.length > 0 && (
        <Card title="History" pad={false}>
          <Divided className="px-4 pb-1">
            {history.map((a) => (
              <Row
                key={a._id}
                leading={<Initial name={a.member} size={36} />}
                title={`${a.kind === "send" ? `You sent ${a.member}` : `${a.member} asked`} · ${a.note}`}
                sub={`${when(a.createdAt)} · ${a.state === "paid" ? (a.auto ? "Paid inside their allowance" : "Paid") : "Declined"}`}
                trailing={<span className={`num text-body font-semibold ${a.state === "declined" ? "text-mute line-through" : ""}`}>{usd(a.amountMinor)}</span>}
              />
            ))}
          </Divided>
        </Card>
      )}

      <p className="text-label text-mute">
        Family money moves in test dollars from your Nudge wallet. On a simulated wallet both balances change in the app; on an on-chain wallet anything
        that needs you is a payment you approve with your passkey to their own wallet.
      </p>

      {inviting && <InviteSheet relations={data.relations} onClose={() => setInviting(false)} />}
      {editing && <EditSheet m={editing} relations={data.relations} onClose={() => setEditing(null)} />}
      {sending && <SendSheet m={sending} onClose={() => setSending(null)} />}
    </div>
  );
}

function inviteUrl(code: string) {
  return `${typeof window === "undefined" ? "" : window.location.origin}/family/join?code=${code}`;
}

function CopyLink({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="press inline-flex items-center gap-1 text-label font-semibold text-cyan-ink"
      onClick={() => {
        void navigator.clipboard?.writeText(`Join my family on Nudge: ${inviteUrl(code)}`);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />} {copied ? "Copied" : "Copy invite link"}
    </button>
  );
}

function MemberRow({ m, onEdit, onSend }: { m: Member; onEdit: () => void; onSend: () => void }) {
  const reissue = useMutation(api.circle.reissue);
  const remove = useMutation(api.circle.remove);
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-start gap-3">
        <Initial name={m.name} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body font-semibold">{m.name}</span>
            <Chip>{m.relation}</Chip>
            {m.status === "invited" ? <Chip tone="amber">Invited</Chip> : m.sample ? <Chip>Sample</Chip> : <Chip tone="green">Joined</Chip>}
            {m.canProtect && (
              <Chip tone="cyan">
                <ShieldCheck className="size-3" /> Guardian
              </Chip>
            )}
          </div>
          <div className="text-label text-mute">
            {m.status === "active" && m.account ? `Signed in as ${m.account.name}${m.account.email ? ` · ${m.account.email}` : ""}` : m.status === "invited" ? "Waiting for them to open the link" : "Demo member"}
          </div>
        </div>
        <button className="press grid size-9 place-items-center rounded-full text-mute hover:bg-page" aria-label={`Settings for ${m.name}`} onClick={onEdit}>
          <Settings2 className="size-4" />
        </button>
      </div>
      {m.status === "invited" ? (
        <div className="mt-2 flex flex-wrap items-center gap-3 rounded-[12px] bg-page p-3">
          {m.code ? (
            <>
              <span className="num text-label text-ink-2">Code {m.code}</span>
              <CopyLink code={m.code} />
            </>
          ) : (
            <button className="press text-label font-semibold text-cyan-ink" onClick={() => reissue({ linkId: m._id })}>
              Invite expired · make a new link
            </button>
          )}
          <button className="press ml-auto text-label font-semibold text-red" onClick={() => remove({ linkId: m._id })}>
            Cancel invite
          </button>
        </div>
      ) : (
        <>
          <div className="mt-3 flex items-baseline justify-between text-label">
            <span className="text-ink-2">Allowance this month</span>
            <span className="num">
              <b>{usd(m.usedMinor)}</b> <span className="text-mute">of {usd(m.allowanceMinor)}</span>
            </span>
          </div>
          <Meter value={m.usedMinor} max={Math.max(1, m.allowanceMinor)} className="mt-1.5" />
          <div className="mt-1.5 text-label text-mute">
            {m.autoApproveMinor > 0 ? `Asks up to ${usd(m.autoApproveMinor)} are paid without asking you, while allowance lasts.` : "Every ask comes to you."}
          </div>
          <div className="mt-3 flex gap-2">
            <Button size="sm" icon={Send} onClick={onSend}>
              Send money
            </Button>
            <Button size="sm" tone="ghost" icon={Settings2} onClick={onEdit}>
              Allowance
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function AskRow({ ask }: { ask: Data["asks"][number] }) {
  const link = useQuery(api.circle.approvalFor, { askId: ask._id });
  const decline = useMutation(api.circle.decline);
  const decide = useMutation(api.approvals.decide);
  const [error, setError] = useState<string>();
  return (
    <div className="py-3">
      <div className="flex items-start gap-3">
        <Initial name={ask.member} size={40} />
        <div className="min-w-0 flex-1">
          <div className="text-body font-semibold">
            {ask.member} asks for {usd(ask.amountMinor)}
          </div>
          <div className="text-label text-ink-2">{ask.note}</div>
          <div className="text-label text-mute">{when(ask.createdAt)} · above what they get without asking</div>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Button tone="outline" onClick={() => decline({ askId: ask._id }).catch((e) => setError(errorMessage(e)))}>
          Decline
        </Button>
        {link?.token && link.live ? (
          <Button onClick={() => window.location.assign(approvalLink(link.token!))}>Approve with passkey</Button>
        ) : (
          <Button disabled={!link?.token} onClick={() => link?.token && decide({ token: link.token, approve: true }).catch((e) => setError(errorMessage(e)))}>
            Approve and send
          </Button>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

function SupportedBy({ s, myAsks }: { s: Data["supporters"][number]; myAsks: Data["myAsks"] }) {
  const ask = useMutation(api.circle.ask);
  const leave = useMutation(api.circle.remove);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [result, setResult] = useState<string>();
  const [error, setError] = useState<string>();
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <HeartHandshake className="size-5 text-cyan-ink" /> {s.ownerName} supports you
        </span>
      }
      className="border-l-4 border-cyan"
    >
      <div className="text-label text-mute">{s.ownerEmail}</div>
      <div className="mt-2 grid grid-cols-2 gap-3 rounded-[12px] bg-page p-3">
        <div>
          <div className="text-label text-mute">Left this month</div>
          <div className="num text-title font-semibold">{usd(s.leftMinor)}</div>
        </div>
        <div>
          <div className="text-label text-mute">Paid without asking up to</div>
          <div className="num text-title font-semibold">{usd(s.autoApproveMinor)}</div>
        </div>
      </div>
      <form
        className="mt-3 space-y-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(undefined);
          setResult(undefined);
          try {
            const r = await ask({ linkId: s.linkId, amountMinor: toMinorUnits(amount, "USD") ?? 0, note });
            setResult(r === "paid" ? "Sent to your wallet: it was inside your allowance." : `Asked ${s.ownerName}. You'll see their answer here.`);
            setAmount("");
            setNote("");
          } catch (err) {
            setError(errorMessage(err));
          }
        }}
      >
        <div className="grid grid-cols-[120px_1fr] gap-2">
          <MoneyInput currency="USD" value={amount} onChange={setAmount} />
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What it's for" maxLength={120} />
        </div>
        <Button type="submit" className="w-full" icon={HandCoins} disabled={!amount}>
          Ask {s.ownerName}
        </Button>
        {result && <p className="rounded-btn bg-green-soft p-2.5 text-label text-green">{result}</p>}
        <ErrorText>{error}</ErrorText>
      </form>
      {myAsks.length > 0 && (
        <Divided className="mt-2">
          {myAsks.slice(0, 5).map((a) => (
            <Row
              key={a._id}
              title={a.note}
              sub={when(a.createdAt)}
              trailing={
                <span className="flex items-center gap-2">
                  <span className="num text-body">{usd(a.amountMinor)}</span>
                  <Chip tone={a.state === "paid" ? "green" : a.state === "declined" ? "red" : "amber"}>{a.state === "paid" ? (a.kind === "send" ? "Received" : "Paid") : a.state === "declined" ? "Declined" : "Waiting"}</Chip>
                </span>
              }
            />
          ))}
        </Divided>
      )}
      <button className="press mt-3 text-label font-semibold text-mute" onClick={() => leave({ linkId: s.linkId })}>
        Leave {s.ownerName}&apos;s family
      </button>
    </Card>
  );
}

function InviteSheet({ relations, onClose }: { relations: string[]; onClose: () => void }) {
  const invite = useMutation(api.circle.invite);
  const [form, setForm] = useState({ name: "", relation: "Child", allowance: "30", auto: "5", protect: false });
  const [code, setCode] = useState<string>();
  const [error, setError] = useState<string>();
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={code ? "Send them this link" : "Invite to your family"}>
      {code ? (
        <div className="space-y-3 pb-4">
          <p className="text-body text-ink-2">
            They open it, sign in to Nudge with their own account and accept. You'll both see who the other is before anything links. Valid for 7 days, works
            once.
          </p>
          <div className="num rounded-btn bg-page p-3 text-label break-all">{inviteUrl(code)}</div>
          <div className="flex items-center justify-between">
            <span className="num text-label text-mute">Code {code}</span>
            <CopyLink code={code} />
          </div>
          <Button size="lg" className="w-full" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : (
        <form
          className="space-y-3 pb-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(undefined);
            try {
              const r = await invite({
                name: form.name,
                relation: form.relation,
                allowanceMinor: toMinorUnits(form.allowance || "0", "USD") ?? 0,
                autoApproveMinor: toMinorUnits(form.auto || "0", "USD") ?? 0,
                canProtect: form.protect,
              });
              setCode(r.code);
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="Their name">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Priya" />
            </Field>
            <Field label="They are your">
              <Select value={form.relation} onChange={(e) => setForm({ ...form, relation: e.target.value })}>
                {relations.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Monthly allowance">
              <MoneyInput currency="USD" value={form.allowance} onChange={(allowance) => setForm({ ...form, allowance })} />
            </Field>
            <Field label="Paid without asking up to">
              <MoneyInput currency="USD" value={form.auto} onChange={(auto) => setForm({ ...form, auto })} />
            </Field>
          </div>
          <p className="text-label text-mute">Within the allowance, asks up to the second amount are paid at once. Anything more comes to you to approve.</p>
          <div className="flex items-center justify-between gap-3 rounded-btn border border-line px-3 py-2.5">
            <div>
              <div className="text-body font-semibold">Also my guardian</div>
              <div className="text-label text-mute">They can stop your held payments and freeze your assistants. Never pay or loosen anything.</div>
            </div>
            <Toggle checked={form.protect} onChange={(protect) => setForm({ ...form, protect })} label="Also my guardian" />
          </div>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" size="lg" className="w-full" icon={Plus} disabled={!form.name.trim()}>
            Create invite link
          </Button>
        </form>
      )}
    </Sheet>
  );
}

function EditSheet({ m, relations, onClose }: { m: Member; relations: string[]; onClose: () => void }) {
  const update = useMutation(api.circle.update);
  const remove = useMutation(api.circle.remove);
  const [allowance, setAllowance] = useState(String(m.allowanceMinor / 100));
  const [auto, setAuto] = useState(String(m.autoApproveMinor / 100));
  const [relation, setRelation] = useState(m.relation);
  const [error, setError] = useState<string>();
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={m.name}>
      <div className="space-y-3 pb-4">
        <Field label="They are your">
          <Select value={relation} onChange={(e) => setRelation(e.target.value)}>
            {relations.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Monthly allowance">
            <MoneyInput currency="USD" value={allowance} onChange={setAllowance} />
          </Field>
          <Field label="Paid without asking up to">
            <MoneyInput currency="USD" value={auto} onChange={setAuto} />
          </Field>
        </div>
        <ErrorText>{error}</ErrorText>
        <Button
          size="lg"
          className="w-full"
          onClick={async () => {
            setError(undefined);
            try {
              await update({ linkId: m._id, allowanceMinor: toMinorUnits(allowance || "0", "USD") ?? 0, autoApproveMinor: toMinorUnits(auto || "0", "USD") ?? 0, relation });
              onClose();
            } catch (e) {
              setError(errorMessage(e));
            }
          }}
        >
          Save
        </Button>
        <Button
          tone="danger"
          className="w-full"
          icon={Trash2}
          onClick={async () => {
            await remove({ linkId: m._id });
            onClose();
          }}
        >
          Remove {m.name}
        </Button>
      </div>
    </Sheet>
  );
}

function SendSheet({ m, onClose }: { m: Member; onClose: () => void }) {
  const send = useMutation(api.circle.send);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={`Send ${m.name} money`}>
      {done ? (
        <div className="space-y-3 pb-4 text-center">
          <Copy className="hidden" />
          <p className="text-body text-ink-2">Sent. {m.name} sees it in their wallet.</p>
          <Button size="lg" className="w-full" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : (
        <form
          className="space-y-3 pb-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(undefined);
            try {
              const token = await send({ linkId: m._id as Id<"familyLinks">, amountMinor: toMinorUnits(amount, "USD") ?? 0, note });
              if (token) return window.location.assign(approvalLink(token));
              setDone(true);
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        >
          <Field label="Amount (test dollars)">
            <MoneyInput currency="USD" value={amount} onChange={setAmount} />
          </Field>
          <Field label="Note">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Pocket money" maxLength={120} />
          </Field>
          <ErrorText>{error}</ErrorText>
          <Button type="submit" size="lg" className="w-full" icon={Send} disabled={!amount}>
            Send
          </Button>
        </form>
      )}
    </Sheet>
  );
}
