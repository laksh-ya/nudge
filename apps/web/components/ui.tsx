"use client";

import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";
import { Drawer } from "vaul";
import { STATE_LABEL, type PaymentState } from "@agent-wallet/domain";
import { cn } from "@/lib/cn";
import { formatMoney, type Currency } from "@/lib/format";

export function Card({
  title,
  action,
  children,
  className,
  pad = true,
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  pad?: boolean;
}) {
  return (
    <section className={cn("card rise", pad && "p-4", className)}>
      {title && (
        <header className={cn("mb-3 flex items-center justify-between gap-3", !pad && "px-4 pt-4")}>
          <h2 className="text-title font-semibold text-ink">{title}</h2>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function TextLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="press flex items-center gap-0.5 text-label font-semibold text-cyan-ink">
      {children}
      <ChevronRight className="size-3.5" strokeWidth={2.5} />
    </Link>
  );
}

type ButtonTone = "primary" | "accent" | "outline" | "ghost" | "danger";

const buttonTone: Record<ButtonTone, string> = {
  primary: "bg-navy text-white hover:bg-navy-deep",
  accent: "bg-cyan text-white hover:bg-cyan-ink",
  outline: "border border-line bg-white text-navy hover:bg-sky-soft",
  ghost: "text-navy hover:bg-sky-soft",
  danger: "bg-red-soft text-red hover:bg-[#fbdede]",
};

export function Button({
  tone = "primary",
  size = "md",
  className,
  icon: Icon,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: ButtonTone;
  size?: "sm" | "md" | "lg";
  icon?: LucideIcon;
}) {
  return (
    <button
      {...props}
      className={cn(
        "press inline-flex items-center justify-center gap-1.5 rounded-btn font-semibold whitespace-nowrap disabled:pointer-events-none disabled:opacity-50",
        size === "sm" && "h-8 px-3 text-label",
        size === "md" && "h-10 px-4 text-body",
        size === "lg" && "h-12 px-5 text-title",
        buttonTone[tone],
        className,
      )}
    >
      {Icon && <Icon className={size === "sm" ? "size-3.5" : "size-4"} strokeWidth={2.25} />}
      {props.children}
    </button>
  );
}

export function ButtonLink({
  href,
  tone = "primary",
  size = "md",
  className,
  children,
  external,
}: {
  href: string;
  tone?: ButtonTone;
  size?: "sm" | "md";
  className?: string;
  children: React.ReactNode;
  external?: boolean;
}) {
  const cls = cn(
    "press inline-flex items-center justify-center gap-1.5 rounded-btn font-semibold whitespace-nowrap",
    size === "sm" ? "h-8 px-3 text-label" : "h-10 px-4 text-body",
    buttonTone[tone],
    className,
  );
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener" className={cls}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}

export type Tone = "neutral" | "cyan" | "navy" | "green" | "amber" | "red";

const chipTone: Record<Tone, string> = {
  neutral: "bg-page text-ink-2",
  cyan: "bg-sky text-cyan-ink",
  navy: "bg-navy text-white",
  green: "bg-green-soft text-green",
  amber: "bg-amber-soft text-amber",
  red: "bg-red-soft text-red",
};

export function Chip({ tone = "neutral", children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-micro font-semibold whitespace-nowrap", chipTone[tone], className)}>
      {children}
    </span>
  );
}

const stateTone: Record<PaymentState, Tone> = {
  drafted: "neutral",
  needs_info: "amber",
  checked: "neutral",
  awaiting_approval: "amber",
  reserved: "cyan",
  submitted: "cyan",
  confirmed: "green",
  failed: "red",
  cancelled: "neutral",
  expired: "neutral",
  unknown: "amber",
  queued: "amber",
  held: "amber",
};

export function StateChip({ state }: { state: PaymentState }) {
  return <Chip tone={stateTone[state]}>{STATE_LABEL[state]}</Chip>;
}

export function Money({
  minor,
  currency,
  sign,
  className,
  hidden,
}: {
  minor: number;
  currency: Currency;
  sign?: boolean;
  className?: string;
  hidden?: boolean;
}) {
  return (
    <span className={cn("num", className)}>
      {hidden ? "••••" : formatMoney(minor, currency, { sign })}
    </span>
  );
}

export function IconTile({
  icon: Icon,
  tone = "sky",
  size = "md",
}: {
  icon: LucideIcon;
  tone?: "sky" | "navy" | "green" | "amber" | "red" | "page";
  size?: "sm" | "md" | "lg";
}) {
  const tones = {
    sky: "bg-sky text-navy",
    navy: "bg-navy text-white",
    green: "bg-green-soft text-green",
    amber: "bg-amber-soft text-amber",
    red: "bg-red-soft text-red",
    page: "bg-page text-ink-2",
  };
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center",
        size === "sm" && "size-8 rounded-[10px]",
        size === "md" && "size-10 rounded-[12px]",
        size === "lg" && "size-12 rounded-tile",
        tones[tone],
      )}
    >
      <Icon className={size === "sm" ? "size-4" : "size-5"} strokeWidth={1.9} />
    </span>
  );
}

export function Row({
  leading,
  title,
  sub,
  trailing,
  href,
  onClick,
  className,
}: {
  leading?: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  trailing?: React.ReactNode;
  href?: string;
  onClick?: () => void;
  className?: string;
}) {
  const body = (
    <>
      {leading}
      <div className="min-w-0 flex-1">
        <div className="truncate text-body font-medium text-ink">{title}</div>
        {sub && <div className="truncate text-label text-mute">{sub}</div>}
      </div>
      {trailing && <div className="shrink-0 text-right">{trailing}</div>}
    </>
  );
  const cls = cn("flex w-full items-center gap-3 py-2.5 text-left", (href || onClick) && "press", className);
  if (href) {
    return (
      <Link href={href} className={cls}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cls}>
        {body}
      </button>
    );
  }
  return <div className={cls}>{body}</div>;
}

export function Divided({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("divide-y divide-line", className)}>{children}</div>;
}

export function Meter({
  value,
  max,
  tone = "cyan",
  className,
}: {
  value: number;
  max: number;
  tone?: "cyan" | "navy" | "amber" | "red" | "green" | "white";
  className?: string;
}) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  const fill = {
    cyan: "bg-cyan",
    navy: "bg-navy",
    amber: "bg-amber",
    red: "bg-red",
    green: "bg-green",
    white: "bg-white",
  }[tone];
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-full", tone === "white" ? "bg-white/20" : "bg-page", className)}>
      <div className={cn("h-full rounded-full transition-[width] duration-500", fill)} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} />;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex gap-1 rounded-btn bg-white p-1 shadow-[var(--shadow-card)]", className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "press h-8 flex-1 rounded-[8px] px-3 text-label font-semibold transition-colors",
            o.value === value ? "bg-navy text-white" : "text-ink-2 hover:bg-page",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-body text-mute">{children}</p>;
}

export function Sheet({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-navy-deep/40" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[88dvh] max-w-lg flex-col rounded-t-[20px] bg-white outline-none">
          <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-line" />
          <Drawer.Title className="px-5 pt-4 pb-2 text-head font-semibold">{title}</Drawer.Title>
          <div className="pb-safe overflow-y-auto px-5">{children}</div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

export function PageTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h1 className="text-head font-semibold text-ink lg:text-[24px] lg:leading-[30px]">{children}</h1>
      {action}
    </div>
  );
}
