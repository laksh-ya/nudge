"use client";

import { useMutation } from "convex/react";
import { useRef, useState } from "react";
import { Camera, Check, FileSpreadsheet, FileText, LoaderCircle, Upload } from "lucide-react";
import {
  CATEGORIES,
  country as countryInfo,
  decimalsOf,
  findHeaderRow,
  formatMoney,
  guessMapping,
  linesToTransactions,
  parseReceipt,
  rowsToTransactions,
  type Currency,
  type Field as MapField,
  type Mapping,
  type ParsedRow,
} from "@agent-wallet/domain";
import { api, type Doc, type Id } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ocr, parseFile } from "@/lib/parse-file";
import { Button, Chip, Segmented, Sheet } from "../ui";
import { Choice, ErrorText, Field, Input, MoneyInput, Select, errorMessage, toMinorUnits } from "../form";

export type HistoryMode = "statement" | "scan" | "manual";

type Stage = "pick" | "map" | "review" | "done";
type Result = { rows: number; added: number; duplicates: number; transfers: number };

const MAP_FIELDS: { field: MapField; label: string }[] = [
  { field: "date", label: "Date" },
  { field: "description", label: "Description" },
  { field: "amount", label: "Amount" },
  { field: "debit", label: "Money out" },
  { field: "credit", label: "Money in" },
  { field: "balance", label: "Balance" },
  { field: "direction", label: "In or out" },
  { field: "status", label: "Status" },
];

const SAMPLES = [
  { file: "hdfc-savings-sample.csv", label: "HDFC savings, 3 months", order: "dmy" as const },
  { file: "alipay-sample.csv", label: "Alipay bill export, 3 months", order: "ymd" as const },
];

export function HistorySheet({
  open,
  onOpenChange,
  account,
  mode,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  account: Pick<Doc<"accounts">, "_id" | "name" | "currency" | "kind" | "country">;
  mode: HistoryMode;
  onDone?: (r: Result) => void;
}) {
  const title = mode === "statement" ? `Import into ${account.name}` : mode === "scan" ? "Scan" : "Add a transaction";
  const close = (o: boolean) => onOpenChange(o);
  return (
    <Sheet open={open} onOpenChange={close} title={title}>
      {open && mode === "statement" && <StatementFlow account={account} onDone={onDone} close={() => close(false)} />}
      {open && mode === "scan" && <ScanFlow account={account} onDone={onDone} close={() => close(false)} />}
      {open && mode === "manual" && <ManualFlow account={account} onDone={onDone} close={() => close(false)} />}
    </Sheet>
  );
}

type FlowProps = {
  account: Pick<Doc<"accounts">, "_id" | "name" | "currency" | "kind" | "country">;
  onDone?: (r: Result) => void;
  close: () => void;
};

function useCommit(account: FlowProps["account"]) {
  const commit = useMutation(api.imports.commit);
  const uploadUrl = useMutation(api.imports.uploadUrl);
  return async (rows: ParsedRow[], kind: "csv" | "xlsx" | "pdf" | "scan", file?: Blob, fileName?: string) => {
    let fileId: Id<"_storage"> | undefined;
    if (file && file.size < 15_000_000) {
      try {
        const url = await uploadUrl();
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
        if (res.ok) fileId = ((await res.json()) as { storageId: Id<"_storage"> }).storageId;
      } catch {}
    }
    const total: Result = { rows: 0, added: 0, duplicates: 0, transfers: 0 };
    for (let i = 0; i < rows.length; i += 1500) {
      const chunk = rows.slice(i, i + 1500).map((r) => ({
        at: r.at,
        amountMinor: r.amountMinor,
        description: r.description,
        balanceMinor: r.balanceMinor,
        pending: r.pending,
      }));
      const r = await commit({ accountId: account._id, kind, fileName, fileId: i === 0 ? fileId : undefined, rows: chunk });
      total.rows += r.rows;
      total.added += r.added;
      total.duplicates += r.duplicates;
      total.transfers += r.transfers;
    }
    return total;
  };
}

function StatementFlow({ account, onDone, close }: FlowProps) {
  const [stage, setStage] = useState<Stage>("pick");
  const [file, setFile] = useState<{ blob: Blob; name: string; kind: "csv" | "xlsx" | "pdf" } | null>(null);
  const [table, setTable] = useState<string[][]>([]);
  const [header, setHeader] = useState(0);
  const [mapping, setMapping] = useState<Mapping>({});
  const [order, setOrder] = useState(countryInfo(account.country).dateOrder);
  const [flip, setFlip] = useState(false);
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<Result>();
  const input = useRef<HTMLInputElement>(null);
  const commit = useCommit(account);
  const decimals = decimalsOf(account.currency);

  async function load(blob: Blob, name: string, preferOrder?: "dmy" | "mdy" | "ymd") {
    setError(undefined);
    setBusy(true);
    try {
      const f = new File([blob], name, { type: blob.type });
      const parsed = await parseFile(f);
      const o = preferOrder ?? order;
      if (preferOrder) setOrder(preferOrder);
      if (parsed.kind === "pdf") {
        const found = linesToTransactions(parsed.lines, o, decimals);
        if (found.length === 0) throw new Error("No transactions found in this PDF. Try the CSV or Excel export.");
        setFile({ blob, name, kind: "pdf" });
        setRows(found);
        setStage("review");
      } else {
        if (parsed.table.length < 2) throw new Error("This file looks empty");
        const h = findHeaderRow(parsed.table);
        const m = guessMapping(parsed.table[h] ?? []);
        setFile({ blob, name, kind: parsed.kind });
        setTable(parsed.table);
        setHeader(h);
        setMapping(m);
        setStage("map");
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const headers = table[header] ?? [];
  const preview = rowsToTransactions(table.slice(header + 1), mapping, { order, decimals, flipSign: flip });
  const ready = mapping.date !== undefined && (mapping.amount !== undefined || mapping.debit !== undefined || mapping.credit !== undefined);

  if (stage === "done" && result) return <Done result={result} close={close} />;

  if (stage === "pick") {
    return (
      <div className="space-y-3 pb-4">
        <input
          ref={input}
          type="file"
          accept=".csv,.xlsx,.xls,.pdf,text/csv,application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void load(f, f.name);
            e.target.value = "";
          }}
        />
        <button
          onClick={() => input.current?.click()}
          disabled={busy}
          className="press flex w-full flex-col items-center gap-2 rounded-[14px] border-2 border-dashed border-line px-4 py-8 text-center hover:border-cyan hover:bg-sky-soft disabled:opacity-60"
        >
          {busy ? <LoaderCircle className="size-7 animate-spin text-cyan" /> : <Upload className="size-7 text-navy" />}
          <span className="text-title font-semibold">{busy ? "Reading" : "Choose a file"}</span>
          <span className="text-label text-mute">CSV, Excel or PDF. Start with the last 3 months.</span>
        </button>
        <ErrorText>{error}</ErrorText>
        <div className="pt-1 text-label font-semibold text-mute">Or try a sample</div>
        {SAMPLES.map((s) => (
          <button
            key={s.file}
            disabled={busy}
            onClick={async () => {
              const res = await fetch(`/samples/${s.file}`);
              await load(await res.blob(), s.file, s.order);
            }}
            className="press flex w-full items-center gap-3 rounded-btn border border-line p-3 text-left hover:bg-page"
          >
            <FileSpreadsheet className="size-5 text-navy" />
            <span className="text-body font-medium">{s.label}</span>
          </button>
        ))}
      </div>
    );
  }

  if (stage === "map") {
    return (
      <div className="space-y-4 pb-4">
        <div className="flex items-center gap-2 text-label text-mute">
          <FileSpreadsheet className="size-4" /> {file?.name} · {table.length - header - 1} rows
        </div>
        <div className="grid grid-cols-2 gap-3">
          {MAP_FIELDS.map(({ field, label }) => (
            <Field key={field} label={label}>
              <Select
                value={mapping[field] ?? ""}
                onChange={(e) => {
                  const v = e.target.value === "" ? undefined : Number(e.target.value);
                  setMapping((m) => ({ ...m, [field]: v }));
                }}
              >
                <option value="">Not in file</option>
                {headers.map((h, i) => (
                  <option key={i} value={i}>
                    {h || `Column ${i + 1}`}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date format">
            <Select value={order} onChange={(e) => setOrder(e.target.value as typeof order)}>
              <option value="dmy">Day / month / year</option>
              <option value="mdy">Month / day / year</option>
              <option value="ymd">Year / month / day</option>
            </Select>
          </Field>
          <Field label="Signs">
            <Choice selected={flip} onClick={() => setFlip((f) => !f)} className="h-11">
              Purchases are positive
            </Choice>
          </Field>
        </div>
        <ErrorText>{!ready ? "Pick the date and amount columns" : preview.length === 0 ? "No rows could be read with these columns" : undefined}</ErrorText>
        <Button size="lg" className="w-full" disabled={!ready || preview.length === 0} onClick={() => {
          setRows(preview);
          setStage("review");
        }}>
          Review {preview.length} transactions
        </Button>
      </div>
    );
  }

  return (
    <Review
      rows={rows}
      currency={account.currency}
      busy={busy}
      error={error}
      icon={file?.kind === "pdf" ? FileText : FileSpreadsheet}
      fileName={file?.name}
      onBack={() => setStage(file?.kind === "pdf" ? "pick" : "map")}
      onConfirm={async (chosen) => {
        setBusy(true);
        setError(undefined);
        try {
          const r = await commit(chosen, file!.kind, file?.blob, file?.name);
          setResult(r);
          setStage("done");
          onDone?.(r);
        } catch (e) {
          setError(errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

function Review({
  rows,
  currency,
  busy,
  error,
  icon: Icon,
  fileName,
  onBack,
  onConfirm,
}: {
  rows: ParsedRow[];
  currency: Currency;
  busy: boolean;
  error?: string;
  icon: typeof FileText;
  fileName?: string;
  onBack: () => void;
  onConfirm: (rows: ParsedRow[]) => void;
}) {
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const chosen = rows.filter((_, i) => !skip.has(i));
  const moneyIn = chosen.filter((r) => r.amountMinor > 0).reduce((s, r) => s + r.amountMinor, 0);
  const moneyOut = chosen.filter((r) => r.amountMinor < 0).reduce((s, r) => s - r.amountMinor, 0);
  const from = Math.min(...rows.map((r) => r.at));
  const to = Math.max(...rows.map((r) => r.at));
  const fmt = (t: number) => new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return (
    <div className="pb-4">
      <div className="mb-3 flex items-center gap-2 text-label text-mute">
        <Icon className="size-4" /> {fileName} · {fmt(from)} to {fmt(to)}
      </div>
      <div className="mb-3 grid grid-cols-3 gap-2">
        {[
          ["Transactions", String(chosen.length)],
          ["Money in", formatMoney(moneyIn, currency)],
          ["Money out", formatMoney(moneyOut, currency)],
        ].map(([l, v]) => (
          <div key={l} className="rounded-[12px] bg-page p-2.5">
            <div className="text-micro font-semibold text-mute uppercase">{l}</div>
            <div className="num truncate text-body font-semibold">{v}</div>
          </div>
        ))}
      </div>
      <div className="max-h-[38dvh] divide-y divide-line overflow-y-auto rounded-[12px] border border-line">
        {rows.map((r, i) => {
          const off = skip.has(i);
          return (
            <button
              key={i}
              type="button"
              onClick={() => setSkip((s) => {
                const n = new Set(s);
                if (n.has(i)) n.delete(i);
                else n.add(i);
                return n;
              })}
              className={cn("flex w-full items-center gap-3 px-3 py-2 text-left", off && "opacity-40")}
            >
              <span className={cn("grid size-4 shrink-0 place-items-center rounded border", off ? "border-line" : "border-navy bg-navy text-white")}>
                {!off && <Check className="size-3" strokeWidth={3} />}
              </span>
              <span className="w-14 shrink-0 text-label text-mute">{new Date(r.at).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" })}</span>
              <span className="min-w-0 flex-1 truncate text-label">{r.description}</span>
              <span className={cn("num shrink-0 text-label font-semibold", r.amountMinor > 0 && "text-green")}>
                {formatMoney(r.amountMinor, currency, { sign: true })}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-label text-mute">Tap a row to leave it out. Rows you've imported before are skipped automatically.</p>
      <ErrorText>{error}</ErrorText>
      <div className="mt-4 grid grid-cols-[1fr_2fr] gap-2">
        <Button tone="outline" size="lg" onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button size="lg" disabled={busy || chosen.length === 0} onClick={() => onConfirm(chosen)}>
          {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
          Import {chosen.length}
        </Button>
      </div>
    </div>
  );
}

function Done({ result, close }: { result: Result; close: () => void }) {
  return (
    <div className="pb-4 text-center">
      <span className="pop mx-auto mt-2 grid size-14 place-items-center rounded-full bg-green text-white">
        <Check className="size-7" strokeWidth={3} />
      </span>
      <div className="mt-3 text-head font-semibold">{result.added} added</div>
      <div className="mt-1 flex flex-wrap justify-center gap-1.5">
        {result.duplicates > 0 && <Chip>{result.duplicates} already known</Chip>}
        {result.transfers > 0 && <Chip tone="cyan">{result.transfers} transfers matched</Chip>}
      </div>
      <Button size="lg" className="mt-5 w-full" onClick={close}>
        Done
      </Button>
    </div>
  );
}

function ScanFlow({ account, onDone, close }: FlowProps) {
  const [kind, setKind] = useState<"receipt" | "passbook">("receipt");
  const [image, setImage] = useState<{ blob: Blob; url: string } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [rows, setRows] = useState<ParsedRow[] | null>(null);
  const [form, setForm] = useState({ merchant: "", amount: "", date: today(), category: "" });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>();
  const input = useRef<HTMLInputElement>(null);
  const addOne = useMutation(api.imports.addOne);
  const uploadUrl = useMutation(api.imports.uploadUrl);
  const commit = useCommit(account);
  const order = countryInfo(account.country).dateOrder;

  async function read(blob: Blob) {
    setError(undefined);
    setImage({ blob, url: URL.createObjectURL(blob) });
    setProgress(0);
    try {
      const text = await ocr(blob, setProgress);
      if (kind === "receipt") {
        const r = parseReceipt(text, order);
        setForm((f) => ({
          ...f,
          merchant: r.merchant || f.merchant,
          amount: r.total ? String(r.total) : f.amount,
          date: r.at ? new Date(r.at).toISOString().slice(0, 10) : f.date,
        }));
      } else {
        const found = linesToTransactions(text.split("\n"), order, decimalsOf(account.currency));
        if (found.length === 0) setError("No rows found. Try a sharper photo, flat and well lit.");
        setRows(found);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setProgress(null);
    }
  }

  if (result) return <Done result={result} close={close} />;

  if (kind === "passbook" && rows && rows.length > 0) {
    return (
      <Review
        rows={rows}
        currency={account.currency}
        busy={busy}
        error={error}
        icon={Camera}
        fileName="Passbook scan"
        onBack={() => setRows(null)}
        onConfirm={async (chosen) => {
          setBusy(true);
          try {
            const r = await commit(chosen, "scan", image?.blob, "passbook.jpg");
            setResult(r);
            onDone?.(r);
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      />
    );
  }

  return (
    <div className="space-y-4 pb-4">
      <Segmented
        options={[
          { value: "receipt", label: "Receipt" },
          { value: "passbook", label: "Passbook page" },
        ]}
        value={kind}
        onChange={(k) => {
          setKind(k);
          setRows(null);
        }}
      />
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void read(f);
          e.target.value = "";
        }}
      />
      <button
        onClick={() => input.current?.click()}
        disabled={progress !== null}
        className="press relative flex h-44 w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-[14px] border-2 border-dashed border-line text-center hover:border-cyan"
      >
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image.url} alt="" className="absolute inset-0 size-full object-cover opacity-40" />
        ) : null}
        <span className="relative flex flex-col items-center gap-2">
          {progress !== null ? <LoaderCircle className="size-7 animate-spin text-cyan" /> : <Camera className="size-7 text-navy" />}
          <span className="text-title font-semibold">
            {progress !== null ? `Reading ${Math.round(progress * 100)}%` : image ? "Take another" : "Take a photo"}
          </span>
          <span className="text-label text-mute">Read on your device. You check it before saving.</span>
        </span>
      </button>
      <ErrorText>{error}</ErrorText>

      {kind === "receipt" && (
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const minor = toMinorUnits(form.amount, account.currency);
            if (!minor) return setError("Enter the amount");
            setBusy(true);
            setError(undefined);
            try {
              let receiptId: Id<"_storage"> | undefined;
              if (image) {
                const url = await uploadUrl();
                const res = await fetch(url, { method: "POST", headers: { "Content-Type": image.blob.type || "image/jpeg" }, body: image.blob });
                if (res.ok) receiptId = ((await res.json()) as { storageId: Id<"_storage"> }).storageId;
              }
              const r = await addOne({
                accountId: account._id,
                at: new Date(`${form.date}T12:00:00Z`).getTime(),
                amountMinor: -Math.abs(minor),
                merchant: form.merchant,
                category: form.category || undefined,
                receiptId,
              });
              setResult(r);
              onDone?.(r);
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Merchant">
            <Input value={form.merchant} onChange={(e) => setForm({ ...form, merchant: e.target.value })} placeholder="Blue Tokai" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Total">
              <MoneyInput currency={account.currency} value={form.amount} onChange={(amount) => setForm({ ...form, amount })} />
            </Field>
            <Field label="Date">
              <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            </Field>
          </div>
          <Field label="Category">
            <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              <option value="">Work it out for me</option>
              {CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Button type="submit" size="lg" className="w-full" disabled={busy || !form.merchant || !form.amount}>
            Save to {account.name}
          </Button>
        </form>
      )}
    </div>
  );
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function ManualFlow({ account, onDone, close }: FlowProps) {
  const [form, setForm] = useState({ merchant: "", amount: "", date: today(), category: "", direction: "out" as "out" | "in", note: "" });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>();
  const addOne = useMutation(api.imports.addOne);
  if (result) return <Done result={result} close={close} />;
  return (
    <form
      className="space-y-3 pb-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const minor = toMinorUnits(form.amount, account.currency);
        if (!minor) return setError("Enter the amount");
        setBusy(true);
        setError(undefined);
        try {
          const r = await addOne({
            accountId: account._id,
            at: new Date(`${form.date}T12:00:00Z`).getTime(),
            amountMinor: form.direction === "out" ? -Math.abs(minor) : Math.abs(minor),
            merchant: form.merchant,
            category: form.category || undefined,
            note: form.note || undefined,
          });
          setResult(r);
          onDone?.(r);
        } catch (e) {
          setError(errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Segmented
        options={[
          { value: "out", label: "Money out" },
          { value: "in", label: "Money in" },
        ]}
        value={form.direction}
        onChange={(direction) => setForm({ ...form, direction })}
      />
      <Field label={form.direction === "out" ? "Paid to" : "Received from"}>
        <Input value={form.merchant} onChange={(e) => setForm({ ...form, merchant: e.target.value })} autoFocus />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount">
          <MoneyInput currency={account.currency} value={form.amount} onChange={(amount) => setForm({ ...form, amount })} />
        </Field>
        <Field label="Date">
          <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
        </Field>
      </div>
      <Field label="Category">
        <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
          <option value="">Work it out for me</option>
          {CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </Select>
      </Field>
      <Field label="Note">
        <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Optional" />
      </Field>
      <ErrorText>{error}</ErrorText>
      <Button type="submit" size="lg" className="w-full" disabled={busy || !form.merchant || !form.amount}>
        Add
      </Button>
    </form>
  );
}
