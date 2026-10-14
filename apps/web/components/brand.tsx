import { cn } from "@/lib/cn";

export function Wordmark({ className, inverse }: { className?: string; inverse?: boolean }) {
  return (
    <span className={cn("text-[20px] leading-none font-extrabold tracking-[-0.035em] [font-stretch:110%]", className)}>
      <span className={inverse ? "text-white" : "text-navy"}>agent</span>
      <span className="text-cyan">wallet</span>
    </span>
  );
}

const providerStyle: Record<string, { bg: string; fg: string; letter: string }> = {
  own: { bg: "#002970", fg: "#ffffff", letter: "a" },
  claude: { bg: "#F4E9E1", fg: "#B8562F", letter: "C" },
  chatgpt: { bg: "#E8F3EF", fg: "#0E7A5A", letter: "G" },
  openclaw: { bg: "#FDECEC", fg: "#C0392B", letter: "O" },
  hermes: { bg: "#EEF0FB", fg: "#4453B8", letter: "H" },
  poke: { bg: "#FFF3D6", fg: "#9A6A00", letter: "P" },
};

export function AgentMark({ provider, size = 40 }: { provider: string; size?: number }) {
  const s = providerStyle[provider] ?? providerStyle.own!;
  return (
    <span
      className="grid shrink-0 place-items-center rounded-[12px] font-bold [font-stretch:110%]"
      style={{ width: size, height: size, background: s.bg, color: s.fg, fontSize: size * 0.42 }}
      aria-hidden
    >
      {s.letter}
    </span>
  );
}

export function Initial({ name, size = 36 }: { name: string; size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full bg-sky font-bold text-navy"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      aria-hidden
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
