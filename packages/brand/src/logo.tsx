import { Character } from "./characters";
import { COLOR, TYPE } from "./tokens";

/**
 * The logo: Nudge winking, then "nudge" in heavy lowercase. The wink is the signature; keep it on
 * the logo and the app icon. Minimum mark size 16px; clear space around it = half the mark.
 */
export function Logo({ size = 28, inverse, wordmark = true, className }: { size?: number; inverse?: boolean; wordmark?: boolean; className?: string }) {
  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center", gap: size * 0.3, lineHeight: 1 }}>
      <Character of="nudge" mood="wink" size={size * 1.18} />
      {wordmark && (
        <span
          style={{
            fontWeight: TYPE.wordmarkWeight,
            fontSize: size,
            letterSpacing: "-0.05em",
            color: inverse ? COLOR.white : COLOR.ink,
            fontStretch: "110%",
            transform: "translateY(-0.04em)",
          }}
        >
          nudge
        </span>
      )}
    </span>
  );
}

/** "nudge!" in a speech pill, for big moments: hero badges, social cards, the end of a tour. */
export function Shout({ size = 64, dark }: { size?: number; dark?: boolean }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: `${size * 0.16}px ${size * 0.42}px ${size * 0.2}px`,
        borderRadius: size,
        background: dark ? "#2A2A2C" : COLOR.white,
        color: dark ? COLOR.white : COLOR.ink,
        fontWeight: TYPE.wordmarkWeight,
        fontSize: size,
        letterSpacing: "-0.05em",
        lineHeight: 1,
        fontStretch: "110%",
        boxShadow: dark ? "none" : "0 2px 0 rgba(0,0,0,0.04), 0 12px 32px rgba(0,0,0,0.08)",
      }}
    >
      nudge!
    </span>
  );
}
