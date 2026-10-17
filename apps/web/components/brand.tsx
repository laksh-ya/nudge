import { Character, Logo, type Mood } from "@agent-wallet/brand";
import { cn } from "@/lib/cn";

/** The logo; the mark and rules live in packages/brand (docs/BRAND.md). */
export function Wordmark({ className, inverse, size = 22 }: { className?: string; inverse?: boolean; size?: number }) {
  return <Logo size={size} inverse={inverse} className={className} />;
}

/**
 * An assistant's character: Nudge for your own, a shape and colour for each provider (packages/brand
 * → CAST). `mood` follows what it's doing; see moodFor.
 */
export function AgentMark({ provider, size = 40, mood = "happy" }: { provider: string; name?: string; size?: number; mood?: Mood }) {
  return <Character of={provider} mood={mood} size={size} />;
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
