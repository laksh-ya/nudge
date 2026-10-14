"use client";

import { Check } from "lucide-react";
import { CURRENCIES, type Currency } from "@agent-wallet/domain";
import { cn } from "@/lib/cn";

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-label font-semibold text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-label text-mute">{hint}</span>}
    </label>
  );
}

const inputCls =
  "h-11 w-full rounded-btn border border-line bg-white px-3 text-[16px] text-ink outline-none transition-colors placeholder:text-mute focus:border-cyan focus:ring-2 focus:ring-sky lg:text-body";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(inputCls, props.className)} />;
}

export function Select({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        inputCls,
        "appearance-none bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23505050%22 stroke-width=%222.5%22><path d=%22m6 9 6 6 6-6%22/></svg>')] bg-[right_12px_center] bg-no-repeat pr-9",
        className,
      )}
    >
      {children}
    </select>
  );
}

/** Amount input in major units; reports integer minor units. */
export function MoneyInput({
  currency,
  value,
  onChange,
  placeholder,
  allowNegative,
  autoFocus,
}: {
  currency: Currency;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  allowNegative?: boolean;
  autoFocus?: boolean;
}) {
  const symbol = CURRENCIES[currency].symbol.trim();
  return (
    <div className="relative">
      <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-body font-semibold text-ink-2">{symbol}</span>
      <input
        inputMode="decimal"
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder ?? "0"}
        onChange={(e) => {
          const v = e.target.value.replace(allowNegative ? /[^\d.,-]/g : /[^\d.,]/g, "");
          onChange(v);
        }}
        className={cn(inputCls, "num font-semibold", symbol.length > 1 ? "pl-12" : "pl-8")}
      />
    </div>
  );
}

export function toMinorUnits(v: string, currency: Currency): number | null {
  const n = Number(v.replace(/,/g, ""));
  if (!v.trim() || !Number.isFinite(n)) return null;
  return Math.round(n * 10 ** CURRENCIES[currency].decimals);
}

export function fromMinorUnits(minor: number | undefined, currency: Currency): string {
  if (!minor) return "";
  return String(minor / 10 ** CURRENCIES[currency].decimals);
}

export function Choice({
  selected,
  onClick,
  children,
  className,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "press relative flex items-center gap-2 rounded-btn border px-3 py-2.5 text-left text-body font-medium transition-colors",
        selected ? "border-navy bg-sky-soft text-navy" : "border-line bg-white text-ink hover:border-[#cfd8e3]",
        className,
      )}
    >
      {children}
      {selected && (
        <span className="ml-auto grid size-5 shrink-0 place-items-center rounded-full bg-navy text-white">
          <Check className="size-3" strokeWidth={3} />
        </span>
      )}
    </button>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn("relative h-7 w-12 shrink-0 rounded-full transition-colors duration-200", checked ? "bg-navy" : "bg-line")}
    >
      <span
        className={cn(
          "absolute top-1 left-1 size-5 rounded-full bg-white shadow transition-transform duration-200 ease-[var(--ease-snap)]",
          checked && "translate-x-5",
        )}
      />
    </button>
  );
}

export function ErrorText({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return <p className="mt-2 text-label font-medium text-red">{children}</p>;
}

export function errorMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  // Convex wraps server errors: "[CONVEX M(x)] [Request ID: …] Server Error\nUncaught Error: message\n  at …"
  const uncaught = m.match(/Uncaught Error: ([^\n]+)/);
  return (uncaught?.[1] ?? m).slice(0, 160);
}
