import { COLOR } from "./tokens";

/**
 * Dot-matrix illustrations for explaining features, in the spirit of OpenAI's dot artwork: a grid
 * of small dots where some are lit to draw a shape (a shield, a coin, a lock, a path). Calm and
 * technical, so it sits behind marketing copy without competing with the characters.
 */
export type DotArt = "shield" | "coin" | "lock" | "path" | "pause" | "plug";

const ART: Record<DotArt, (x: number, y: number) => number> = {
  // Each returns 0 (unlit) to 1 (fully lit) for a point in a 0..1 square.
  shield: (x, y) => {
    const cx = x - 0.5;
    const inside = y > 0.14 && y < 0.88 && Math.abs(cx) < 0.34 * (y < 0.55 ? 1 : 1 - (y - 0.55) / 0.36);
    const tick = Math.abs(y - (0.62 - Math.abs(cx + 0.06) * (cx < -0.06 ? -0.9 : 1.3))) < 0.05 && cx > -0.2 && cx < 0.2;
    return tick ? 0.15 : inside ? 1 : 0;
  },
  coin: (x, y) => {
    const d = Math.hypot(x - 0.5, y - 0.5);
    return d < 0.36 ? (d > 0.27 || (Math.abs(x - 0.5) < 0.04 && Math.abs(y - 0.5) < 0.18) ? 1 : 0.35) : 0;
  },
  lock: (x, y) => {
    const body = y > 0.45 && y < 0.86 && x > 0.24 && x < 0.76;
    const r = Math.hypot(x - 0.5, y - 0.45);
    const shackle = y <= 0.45 && r > 0.12 && r < 0.2;
    const hole = Math.hypot(x - 0.5, y - 0.63) < 0.05;
    return hole ? 0 : body || shackle ? 1 : 0;
  },
  path: (x, y) => {
    const wave = 0.5 + 0.22 * Math.sin(x * Math.PI * 2.2);
    return Math.abs(y - wave) < 0.05 ? 1 : Math.abs(y - wave) < 0.1 ? 0.3 : 0;
  },
  pause: (x, y) => (y > 0.22 && y < 0.78 && ((x > 0.3 && x < 0.43) || (x > 0.57 && x < 0.7)) ? 1 : 0),
  plug: (x, y) => {
    const body = y > 0.4 && y < 0.7 && x > 0.3 && x < 0.7;
    const prongs = y > 0.18 && y <= 0.4 && (Math.abs(x - 0.4) < 0.04 || Math.abs(x - 0.6) < 0.04);
    const cord = y >= 0.7 && y < 0.9 && Math.abs(x - 0.5) < 0.04;
    return body || prongs || cord ? 1 : 0;
  },
};

export function Dots({ art, size = 240, grid = 22, color = COLOR.nudge, base = "rgba(29,29,31,0.10)", className }: { art: DotArt; size?: number; grid?: number; color?: string; base?: string; className?: string }) {
  const step = size / grid;
  const dots = [];
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      const x = (i + 0.5) / grid;
      const y = (j + 0.5) / grid;
      const v = ART[art](x, y);
      dots.push(<circle key={`${i}-${j}`} cx={(i + 0.5) * step} cy={(j + 0.5) * step} r={step * (v ? 0.3 : 0.16)} fill={v ? color : base} opacity={v ? 0.35 + 0.65 * v : 1} />);
    }
  }
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className={className} aria-hidden>
      {dots}
    </svg>
  );
}
