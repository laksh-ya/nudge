import { CAST_COLOR, COLOR } from "./tokens";

/**
 * The cast. Nudge is your own assistant and the one that watches over the others: a speech bubble,
 * because it's the friend who taps you on the shoulder. Every assistant you connect gets its own
 * flat shape and colour with the same big eyes, so a list of agents reads at a glance and a face
 * tells you what's happening before any words do.
 *
 * Adding a character: give it the next unused shape and colour (never a new colour), a one-line
 * personality, and check it at 24px and 160px. See docs/BRAND.md → "The cast".
 */
export type Mood = "happy" | "wink" | "watch" | "grumpy" | "sleep" | "neutral" | "wow";
export type Shape = "bubble" | "burst" | "circle" | "triangle" | "claw" | "squircle" | "hex";

export type CastMember = { name: string; shape: Shape; color: string; personality: string };

export const CAST: Record<string, CastMember> = {
  nudge: { name: "Nudge", shape: "bubble", color: COLOR.nudge, personality: "Your own assistant and the lookout for the rest. Warm, quick, a little cheeky, never careless with money." },
  claude: { name: "Claude", shape: "burst", color: CAST_COLOR.coral, personality: "Thoughtful and thorough; checks before it pays." },
  chatgpt: { name: "ChatGPT", shape: "circle", color: CAST_COLOR.mint, personality: "Easygoing all-rounder." },
  hermes: { name: "Hermes", shape: "triangle", color: CAST_COLOR.sunny, personality: "Fast messenger; always on the move." },
  openclaw: { name: "OpenClaw", shape: "claw", color: CAST_COLOR.cherry, personality: "Grabby; the one most likely to try a forwarded invoice." },
  poke: { name: "Poke", shape: "squircle", color: CAST_COLOR.grape, personality: "Lives in your texts." },
  instinct: { name: "Instinct", shape: "hex", color: CAST_COLOR.mint, personality: "Acts on a hunch, then checks its limits." },
  other: { name: "Any assistant", shape: "hex", color: CAST_COLOR.pebble, personality: "Anyone new, until it earns a colour." },
};

/** The owner's own assistant is stored as provider "own"; it's Nudge. */
export function castOf(provider: string | undefined): CastMember {
  if (!provider || provider === "own") return CAST.nudge!;
  return CAST[provider] ?? CAST.other!;
}

/** Which face goes with a payment or approval state. One mapping, used everywhere. */
export function moodFor(state: string): Mood {
  if (["confirmed", "paid", "submitted", "done", "active"].includes(state)) return "happy";
  if (["awaiting_approval", "needs_approval", "needs_you"].includes(state)) return "wink";
  if (["held", "queued", "reserved", "unknown", "pending"].includes(state)) return "watch";
  if (["refused", "failed", "blocked", "revoked"].includes(state)) return "grumpy";
  if (["frozen", "cancelled", "expired"].includes(state)) return "sleep";
  return "neutral";
}

const INK = COLOR.ink;

const BURST = (() => {
  const pts: string[] = [];
  for (let i = 0; i < 16; i++) {
    const r = i % 2 === 0 ? 52 : 40;
    const a = (Math.PI * 2 * i) / 16 - Math.PI / 2;
    pts.push(`${(60 + r * Math.cos(a)).toFixed(1)},${(62 + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(" ");
})();

function Body({ shape, color }: { shape: Shape; color: string }) {
  // Same-colour round strokes soften every corner, like cut paper.
  const soft = { fill: color, stroke: color, strokeLinejoin: "round" as const };
  switch (shape) {
    case "bubble":
      return <path d="M36 12h48a28 28 0 0 1 28 28v32a28 28 0 0 1-28 28H50l-22 16 5-18A28 28 0 0 1 8 72V40a28 28 0 0 1 28-28z" fill={color} />;
    case "burst":
      return <polygon points={BURST} {...soft} strokeWidth={12} />;
    case "circle":
      return <circle cx="60" cy="62" r="52" fill={color} />;
    case "triangle":
      return <polygon points="60,18 110,104 10,104" {...soft} strokeWidth={20} />;
    case "claw":
      return (
        <g fill={color}>
          <circle cx="27" cy="24" r="15" />
          <circle cx="93" cy="24" r="15" />
          <rect x="10" y="26" width="100" height="86" rx="28" />
        </g>
      );
    case "squircle":
      return <rect x="8" y="10" width="104" height="104" rx="40" fill={color} />;
    case "hex":
      return <polygon points="60,12 106,38 106,88 60,114 14,88 14,38" {...soft} strokeWidth={12} />;
  }
}

/** Eye centres and the face's vertical position differ a little by shape so faces sit right. */
const FACE_Y: Record<Shape, number> = { bubble: 52, burst: 58, circle: 56, triangle: 70, claw: 64, squircle: 58, hex: 60 };

function Face({ mood, y, look }: { mood: Mood; y: number; look: [number, number] }) {
  const line = { stroke: INK, strokeWidth: 7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" };
  const [lx, ly] = look;
  const eye = (cx: number, dx = lx, dy = ly) => (
    <g>
      <ellipse cx={cx} cy={y} rx={16.5} ry={19} fill="#fff" />
      <ellipse cx={cx + dx} cy={y + dy} rx={8.5} ry={11} fill={INK} />
    </g>
  );
  const L = 41;
  const R = 79;
  const mouthY = y + 24;
  switch (mood) {
    case "happy":
      return (
        <>
          <g className="nudge-eyes">{eye(L)}{eye(R)}</g>
          <path d={`M50 ${mouthY} Q60 ${mouthY + 10} 70 ${mouthY}`} {...line} />
        </>
      );
    case "wink":
      // One eye open, the other a happy "^": Nudge's signature, used on the logo and for "your turn".
      return (
        <>
          <g className="nudge-eyes">{eye(L, 1, 0)}</g>
          <path d={`M66 ${y + 5} L79 ${y - 8} L92 ${y + 5}`} {...line} />
          <path d={`M51 ${mouthY - 2} Q61 ${mouthY + 7} 71 ${mouthY - 3}`} {...line} />
        </>
      );
    case "watch":
      return (
        <>
          <g className="nudge-eyes">{eye(L, 4, -7)}{eye(R, 4, -7)}</g>
          <path d={`M55 ${mouthY + 2} H67`} {...line} />
        </>
      );
    case "grumpy":
      return (
        <>
          <path d={`M25 ${y - 26} L55 ${y - 16}`} {...line} />
          <path d={`M95 ${y - 26} L65 ${y - 16}`} {...line} />
          <g>{eye(L, 0, 4)}{eye(R, 0, 4)}</g>
          <path d={`M52 ${mouthY + 4} Q60 ${mouthY - 1} 68 ${mouthY + 4}`} {...line} />
        </>
      );
    case "sleep":
      return (
        <>
          <path d={`M${L - 11} ${y} Q${L} ${y + 9} ${L + 11} ${y}`} {...line} />
          <path d={`M${R - 11} ${y} Q${R} ${y + 9} ${R + 11} ${y}`} {...line} />
          <path d={`M56 ${mouthY + 2} Q60 ${mouthY + 5} 64 ${mouthY + 2}`} {...line} />
        </>
      );
    case "wow":
      return (
        <>
          <g className="nudge-eyes">{eye(L, 0, 0)}{eye(R, 0, 0)}</g>
          <ellipse cx="60" cy={mouthY + 2} rx="6" ry="7" fill={INK} />
        </>
      );
    case "neutral":
      return <g className="nudge-eyes">{eye(L)}{eye(R)}</g>;
  }
}

/**
 * One character. `of` is an assistant provider ("own" and "nudge" are Nudge); anything unknown
 * is the grey hexagon. `look` nudges the pupils, e.g. [3, -4] to glance up and right.
 */
export function Character({
  of = "nudge",
  mood = "happy",
  size = 40,
  look = [0, 0],
  bob,
  title,
  className,
  style,
}: {
  of?: string;
  mood?: Mood;
  size?: number;
  look?: [number, number];
  bob?: boolean;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const c = castOf(of);
  return (
    <svg
      viewBox="0 0 120 124"
      width={size}
      height={size}
      className={[bob ? "nudge-bob" : "", className ?? ""].join(" ").trim() || undefined}
      style={{ flexShrink: 0, overflow: "visible", ...style }}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <Body shape={c.shape} color={c.color} />
      <Face mood={mood} y={FACE_Y[c.shape]} look={look} />
    </svg>
  );
}
