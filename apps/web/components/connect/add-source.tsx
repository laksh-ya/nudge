"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Banknote,
  Bitcoin,
  ChevronRight,
  CreditCard,
  Eye,
  Globe,
  Landmark,
  Search,
  ShieldCheck,
  Smartphone,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import {
  CAPABILITY_LABEL,
  CARD_NETWORKS,
  COUNTRIES,
  EXCHANGES,
  FIAT_CODES,
  PAYMENT_APPS,
  PREFERRED_USES,
  TRANSFER_PROVIDERS,
  banksFor,
  country as countryInfo,
  detectAddress,
  type Capability,
  type Currency,
  type Provider,
  type SourceKind,
} from "@agent-wallet/domain";
import { api, type Id } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Button, Chip, IconTile, Sheet } from "../ui";
import { Choice, ErrorText, Field, Input, MoneyInput, Select, errorMessage, toMinorUnits } from "../form";

/**
 * What can be connected or imported. Payment apps (UPI and the like) and transfer accounts aren't
 * connectable: their money sits in a bank account or card you add instead, and their exports can be
 * imported there. They stay in KIND_META for accounts added before 18 Oct.
 */
export const CONNECTABLE: SourceKind[] = ["bank", "card", "crypto", "cash"];

export const KIND_META: Record<SourceKind, { label: string; icon: LucideIcon; blurb: string }> = {
  bank: { label: "Bank account", icon: Landmark, blurb: "Savings, current, salary" },
  card: { label: "Card", icon: CreditCard, blurb: "Credit or debit" },
  payment_app: { label: "Payment app", icon: Smartphone, blurb: "UPI, Alipay, WeChat Pay, PayPal" },
  crypto: { label: "Crypto", icon: Bitcoin, blurb: "Wallets, addresses, exchanges" },
  transfer: { label: "Transfer account", icon: Globe, blurb: "Wise and other providers" },
  cash: { label: "Cash or other", icon: Banknote, blurb: "Anything you track by hand" },
  // (crypto covers wallets and addresses; banks cover UPI-linked accounts)
};

type Method = "sandbox" | "statement" | "onchain" | "manual";
type Draft = {
  kind: SourceKind;
  provider?: Provider;
  institution: string;
  name: string;
  country: string;
  currency: Currency;
  method: Method;
  uses: string[];
  last4: string;
  network: string;
  expiry: string;
  address: string;
  chain?: "evm" | "bitcoin" | "solana";
  opening: string;
  cryptoMode?: "browser" | "address" | "exchange";
};

declare global {
  interface Window {
    ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
  }
}

export function AddSourceSheet({
  open,
  onOpenChange,
  initialKind,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialKind?: SourceKind;
  onAdded?: (id: Id<"accounts">, method: Method) => void;
}) {
  const me = useQuery(api.users.me);
  const home = me?.country ?? "IN";
  const [draft, setDraft] = useState<Draft | null>(initialKind ? fresh(initialKind, home) : null);
  const [stage, setStage] = useState<"kind" | "provider" | "details">(initialKind ? "provider" : "kind");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const add = useMutation(api.connections.add);
  const verify = useAction(api.crypto.verifyOwnership);

  function fresh(kind: SourceKind, c: string): Draft {
    const info = countryInfo(c);
    return {
      kind,
      institution: "",
      name: "",
      country: info.code,
      currency: info.currency,
      method: kind === "crypto" ? "onchain" : "statement",
      uses: [],
      last4: "",
      network: kind === "card" ? (info.code === "IN" ? "RuPay" : info.code === "CN" ? "UnionPay" : "Visa") : "",
      expiry: "",
      address: "",
      opening: "",
    };
  }

  const reset = () => {
    setDraft(initialKind ? fresh(initialKind, home) : null);
    setStage(initialKind ? "provider" : "kind");
    setQuery("");
    setError(undefined);
    setBusy(false);
  };

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) setTimeout(reset, 250);
  };

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const providers: Provider[] = useMemo(() => {
    if (!draft) return [];
    const list =
      draft.kind === "bank"
        ? banksFor(draft.country)
        : draft.kind === "payment_app"
          ? [...PAYMENT_APPS].sort((a, b) => Number(b.countries?.includes(home) ?? false) - Number(a.countries?.includes(home) ?? false))
          : draft.kind === "transfer"
            ? TRANSFER_PROVIDERS
            : draft.kind === "crypto"
              ? EXCHANGES
              : [];
    const q = query.trim().toLowerCase();
    return q ? list.filter((p) => p.name.toLowerCase().includes(q)) : list;
  }, [draft, query, home]);

  const pick = (p: Provider | null, institution?: string) => {
    if (!draft) return;
    set({
      provider: p ?? undefined,
      institution: p?.name ?? institution ?? "",
      name: p?.name ?? institution ?? "",
      // Real numbers first; sample data only when the owner picks it.
      method: p?.methods.find((m) => m !== "sandbox") ?? p?.methods[0] ?? "statement",
      cryptoMode: draft.kind === "crypto" ? "exchange" : draft.cryptoMode,
      currency: draft.kind === "crypto" ? "USD" : draft.currency,
    });
    setStage("details");
  };

  const capabilities: Capability[] = useMemo(() => {
    if (!draft) return [];
    if (draft.provider) return draft.provider.can;
    if (draft.kind === "payment_app") return ["read", "handoff"];
    return ["read"];
  }, [draft]);

  async function submit() {
    if (!draft) return;
    setError(undefined);
    setBusy(true);
    try {
      const opening = draft.method === "manual" ? toMinorUnits(draft.opening || "0", draft.currency) : undefined;
      if (draft.method === "manual" && opening === null) throw new Error("Enter the current balance");
      const id = await add({
        kind: draft.kind,
        name: draft.name || draft.institution,
        institution: draft.institution || KIND_META[draft.kind].label,
        providerId: draft.provider?.id,
        country: draft.country,
        currency: draft.currency,
        method: draft.method,
        can: capabilities,
        uses: draft.uses,
        last4: draft.kind === "card" ? draft.last4 : undefined,
        network: draft.kind === "card" ? draft.network : undefined,
        expiry: draft.kind === "card" && draft.expiry ? draft.expiry : undefined,
        chain: draft.kind === "crypto" && draft.method === "onchain" ? draft.chain : undefined,
        address: draft.kind === "crypto" && draft.method === "onchain" ? draft.address.trim() : undefined,
        openingBalanceMinor: opening ?? undefined,
      });
      onAdded?.(id, draft.method);
      close(false);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  async function connectBrowserWallet() {
    setError(undefined);
    if (!window.ethereum) {
      setError("No browser wallet found. Paste the address instead.");
      return;
    }
    setBusy(true);
    try {
      const [address] = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
      if (!address) throw new Error("No account selected");
      const id = await add({
        kind: "crypto",
        name: "Browser wallet",
        institution: "Wallet",
        currency: "USD",
        method: "onchain",
        can: ["read"],
        uses: ["Crypto"],
        chain: "evm",
        address,
      });
      const message = `Nudge ownership check\nAccount: ${id}\nAddress: ${address}\nIssued at: ${Date.now()}\nThis signature does not move any funds.`;
      const signature = (await window.ethereum.request({ method: "personal_sign", params: [message, address] })) as string;
      await verify({ accountId: id, message, signature });
      onAdded?.(id, "onchain");
      close(false);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const title =
    stage === "kind" ? "Add a money source" : draft ? (stage === "details" ? draft.institution || KIND_META[draft.kind].label : KIND_META[draft.kind].label) : "";

  return (
    <Sheet open={open} onOpenChange={close} title={title}>
      {stage !== "kind" && !(initialKind && stage === "provider") && (
        <button
          onClick={() => {
            setError(undefined);
            setStage(stage === "details" && (draft?.kind === "card" || draft?.kind === "cash") ? "kind" : stage === "details" ? "provider" : "kind");
          }}
          className="press -mt-1 mb-3 flex items-center gap-1 text-label font-semibold text-cyan-ink"
        >
          <ArrowLeft className="size-3.5" /> Back
        </button>
      )}

      {stage === "kind" && (
        <div className="grid grid-cols-2 gap-2 pb-4">
          {CONNECTABLE.map((k) => {
            const m = KIND_META[k];
            return (
              <button
                key={k}
                onClick={() => {
                  setDraft(fresh(k, home));
                  setStage(k === "card" || k === "cash" ? "details" : "provider");
                }}
                className="press flex flex-col items-start gap-2 rounded-[14px] border border-line p-3 text-left hover:border-[#cfd8e3]"
              >
                <IconTile icon={m.icon} />
                <span className="text-body font-semibold">{m.label}</span>
                <span className="-mt-1.5 text-label text-mute">{m.blurb}</span>
              </button>
            );
          })}
        </div>
      )}

      {stage === "provider" && draft && (
        <div className="pb-4">
          {draft.kind === "crypto" && (
            <div className="mb-4 space-y-2">
              <button
                onClick={connectBrowserWallet}
                disabled={busy}
                className="press flex w-full items-center gap-3 rounded-[14px] border border-line p-3 text-left hover:border-[#cfd8e3] disabled:opacity-60"
              >
                <IconTile icon={Wallet} />
                <div className="flex-1">
                  <div className="text-body font-semibold">Connect a browser wallet</div>
                  <div className="text-label text-mute">MetaMask, Rabby, Coinbase Wallet. Sign once to prove it's yours.</div>
                </div>
                <ChevronRight className="size-4 text-mute" />
              </button>
              <button
                onClick={() => {
                  set({ cryptoMode: "address", institution: "Wallet", name: "", method: "onchain", currency: "USD" });
                  setStage("details");
                }}
                className="press flex w-full items-center gap-3 rounded-[14px] border border-line p-3 text-left hover:border-[#cfd8e3]"
              >
                <IconTile icon={Eye} />
                <div className="flex-1">
                  <div className="text-body font-semibold">Watch an address</div>
                  <div className="text-label text-mute">Ethereum and EVM networks, Bitcoin or Solana</div>
                </div>
                <ChevronRight className="size-4 text-mute" />
              </button>
              <ErrorText>{error}</ErrorText>
              <div className="pt-2 text-label font-semibold text-mute">Exchanges</div>
            </div>
          )}

          {draft.kind === "bank" && (
            <Field label="Country" className="mb-3">
              <Select value={draft.country} onChange={(e) => set({ country: e.target.value, currency: countryInfo(e.target.value).currency })}>
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {draft.kind !== "crypto" && (
            <div className="relative mb-2">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-mute" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className="pl-9" />
            </div>
          )}

          <div className="divide-y divide-line">
            {providers.map((p) => (
              <button key={p.id} onClick={() => pick(p)} className="press flex w-full items-center gap-3 py-3 text-left">
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-page text-label font-bold text-navy">
                  {p.name.replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body font-semibold">{p.name}</div>
                  {p.note && <div className="truncate text-label text-mute">{p.note}</div>}
                </div>
                {p.methods.includes("sandbox") && <Chip>Sample data</Chip>}
                <ChevronRight className="size-4 text-mute" />
              </button>
            ))}
            {query.trim() && (
              <button onClick={() => pick(null, query.trim())} className="press flex w-full items-center gap-3 py-3 text-left">
                <IconTile icon={KIND_META[draft.kind].icon} tone="page" />
                <div className="text-body font-semibold">Add "{query.trim()}"</div>
              </button>
            )}
          </div>
          {providers.length === 0 && !query.trim() && <p className="py-4 text-body text-mute">Type the name to add it.</p>}
        </div>
      )}

      {stage === "details" && draft && (
        <form
          className="space-y-4 pb-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {draft.kind === "card" && (
            <>
              <Field label="Issuer">
                <Input value={draft.institution} onChange={(e) => set({ institution: e.target.value, name: e.target.value })} placeholder="ICICI Bank" autoFocus />
              </Field>
              <Field label="Network">
                <div className="flex flex-wrap gap-1.5">
                  {CARD_NETWORKS.map((n) => (
                    <button
                      type="button"
                      key={n}
                      onClick={() => set({ network: n })}
                      className={cn("press h-8 rounded-btn border px-3 text-label font-semibold", draft.network === n ? "border-navy bg-navy text-white" : "border-line text-ink-2")}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Last 4 digits">
                  <Input inputMode="numeric" maxLength={4} value={draft.last4} onChange={(e) => set({ last4: e.target.value.replace(/\D/g, "") })} placeholder="1093" className="num" />
                </Field>
                <Field label="Expiry">
                  <Input
                    inputMode="numeric"
                    maxLength={5}
                    value={draft.expiry}
                    onChange={(e) => {
                      const d = e.target.value.replace(/\D/g, "").slice(0, 4);
                      set({ expiry: d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d });
                    }}
                    placeholder="MM/YY"
                    className="num"
                  />
                </Field>
              </div>
              <p className="flex items-start gap-2 rounded-btn bg-sky-soft p-3 text-label text-navy">
                <ShieldCheck className="mt-px size-4 shrink-0" />
                We never ask for your full card number or CVV.
              </p>
            </>
          )}

          {draft.kind === "crypto" && draft.cryptoMode === "address" && (
            <Field label="Address" hint={draft.address ? addressHint(draft.address) : "0x…, bc1…, or a Solana address"}>
              <Input
                value={draft.address}
                autoFocus
                spellCheck={false}
                autoCapitalize="off"
                onChange={(e) => {
                  const address = e.target.value.trim();
                  set({ address, chain: detectAddress(address) ?? undefined });
                }}
                placeholder="0x…"
                className="num"
              />
            </Field>
          )}

          {draft.kind === "cash" && (
            <Field label="Name">
              <Input value={draft.name} onChange={(e) => set({ name: e.target.value, institution: e.target.value })} placeholder="Wallet cash" autoFocus />
            </Field>
          )}

          {draft.kind !== "cash" && (
            <Field label="Nickname">
              <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder={draft.institution || "My account"} />
            </Field>
          )}

          {draft.kind !== "crypto" && (
            <Field label="Currency">
              <Select value={draft.currency} onChange={(e) => set({ currency: e.target.value as Currency })}>
                {FIAT_CODES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {draft.provider && draft.provider.methods.length > 1 && (
            <Field label="How to add history">
              <div className="grid gap-2">
                {draft.provider.methods.map((m) => (
                  <Choice key={m} selected={draft.method === m} onClick={() => set({ method: m })}>
                    <span>
                      <span className="block font-semibold">{methodTitle(m, draft)}</span>
                      <span className="block text-label text-mute">{methodHint(m, draft)}</span>
                    </span>
                  </Choice>
                ))}
              </div>
            </Field>
          )}

          {!draft.provider && draft.kind !== "crypto" && (
            <Field label="How to add history">
              <div className="grid grid-cols-2 gap-2">
                {(["statement", "manual"] as const).map((m) => (
                  <Choice key={m} selected={draft.method === m} onClick={() => set({ method: m })}>
                    {methodTitle(m, draft)}
                  </Choice>
                ))}
              </div>
            </Field>
          )}

          {draft.method === "manual" && (
            <Field label="Current balance" hint={draft.kind === "card" ? "What you owe now, as a negative number" : undefined}>
              <MoneyInput currency={draft.currency} value={draft.opening} onChange={(v) => set({ opening: v })} allowNegative={draft.kind === "card"} />
            </Field>
          )}

          <Field label="Used for">
            <div className="flex flex-wrap gap-1.5">
              {PREFERRED_USES.map((u) => {
                const on = draft.uses.includes(u);
                return (
                  <button
                    type="button"
                    key={u}
                    onClick={() => set({ uses: on ? draft.uses.filter((x) => x !== u) : [...draft.uses, u] })}
                    className={cn("press h-8 rounded-btn border px-3 text-label font-semibold", on ? "border-navy bg-navy text-white" : "border-line text-ink-2")}
                  >
                    {u}
                  </button>
                );
              })}
            </div>
          </Field>

          <div className="rounded-[12px] bg-page p-3">
            <div className="mb-1.5 text-label font-semibold text-ink-2">This connection can</div>
            <div className="flex flex-wrap gap-1.5">
              {capabilities.map((c) => (
                <Chip key={c} tone="cyan">
                  {CAPABILITY_LABEL[c]}
                </Chip>
              ))}
            </div>
            <div className="mt-2 text-label text-mute">Connecting never lets an agent spend. Spending limits are set separately.</div>
          </div>

          <ErrorText>{error}</ErrorText>
          <Button
            type="submit"
            size="lg"
            className="w-full"
            disabled={
              busy ||
              (draft.kind === "card" && (draft.last4.length !== 4 || !draft.institution)) ||
              (draft.cryptoMode === "address" && !draft.chain) ||
              (draft.kind === "cash" && !draft.name)
            }
          >
            {busy ? "Adding" : draft.method === "sandbox" ? `Connect ${draft.institution}` : "Add"}
          </Button>
        </form>
      )}
    </Sheet>
  );
}

function addressHint(address: string) {
  const f = detectAddress(address);
  if (f === "evm") return "EVM address. We'll check Ethereum, Base, Arbitrum, Optimism, Polygon and BNB Chain.";
  if (f === "bitcoin") return "Bitcoin address";
  if (f === "solana") return "Solana address";
  return "That doesn't look like a wallet address";
}

function methodTitle(m: Method, d: Draft) {
  if (m === "sandbox") return `Sample data (simulated ${countryInfo(d.country).bankNetwork ?? "bank"} connection)`;
  if (m === "statement") return "Upload statements";
  if (m === "manual") return "Enter by hand";
  return "On-chain";
}

function methodHint(m: Method, d: Draft) {
  if (m === "sandbox") return "Not your real account: fills in a sample balance and about three months of made-up history, so you can try Nudge. For your real numbers, upload statements or enter by hand.";
  if (m === "statement") return d.kind === "payment_app" ? "Export your bill or activity as CSV or Excel" : "CSV, Excel or PDF from your bank";
  return "Start with today's balance";
}
