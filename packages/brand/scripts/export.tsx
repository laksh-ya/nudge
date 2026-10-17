/**
 * Renders the brand's SVG files from the same components the apps use, so the assets never drift
 * from the product: logo, app icon, favicon, the cast sheet and the moods sheet.
 *
 *   pnpm --filter @agent-wallet/brand assets
 *
 * Writes packages/brand/assets/*.svg and copies the app icon into both apps.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { CAST, COLOR, Character, TYPE, type Mood } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "assets");
const root = join(here, "..", "..", "..");
mkdirSync(out, { recursive: true });

const svg = (w: number, h: number, body: React.ReactNode, bg?: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  renderToStaticMarkup(
    <svg xmlns="http://www.w3.org/2000/svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      {bg && <rect width={w} height={h} rx={0} fill={bg} />}
      {body}
    </svg>,
  ).replace(/ class="[^"]*"/g, "");

const at = (x: number, y: number, node: React.ReactNode) => <g transform={`translate(${x} ${y})`}>{node}</g>;
const wordmark = (x: number, y: number, size: number, fill: string) => (
  // Text, not outlines: install Mona Sans (weight 900) or use the web font when exporting to print.
  <text x={x} y={y} fontFamily={`'${TYPE.sans}', 'Arial Black', sans-serif`} fontWeight={TYPE.wordmarkWeight} fontSize={size} letterSpacing={-size * 0.05} fill={fill}>
    nudge
  </text>
);

const files: Record<string, string> = {
  "mark.svg": svg(120, 124, <Character of="nudge" mood="wink" size={120} />),
  "logo.svg": svg(360, 120, <>{at(0, 0, <Character of="nudge" mood="wink" size={110} />)}{wordmark(128, 84, 84, COLOR.ink)}</>),
  "logo-inverse.svg": svg(360, 120, <>{at(0, 0, <Character of="nudge" mood="wink" size={110} />)}{wordmark(128, 84, 84, COLOR.white)}</>, COLOR.ink),
  // App icon and favicon: Nudge winking on a white squircle, like a sticker.
  "icon.svg": svg(
    512,
    512,
    <>
      <rect width="512" height="512" rx="116" fill={COLOR.white} />
      {at(76, 70, <Character of="nudge" mood="wink" size={360} />)}
    </>,
  ),
  "cast.svg": svg(
    Object.keys(CAST).length * 140 + 20,
    160,
    <>{Object.keys(CAST).map((k, i) => <g key={k}>{at(20 + i * 140, 18, <Character of={k} mood={k === "nudge" ? "wink" : "happy"} size={120} />)}</g>)}</>,
    COLOR.paper,
  ),
  "moods.svg": (() => {
    const moods: Mood[] = ["happy", "wink", "watch", "grumpy", "sleep", "wow", "neutral"];
    const keys = Object.keys(CAST);
    return svg(
      moods.length * 100 + 20,
      keys.length * 100 + 20,
      <>{keys.flatMap((k, r) => moods.map((m, c) => <g key={`${k}-${m}`}>{at(20 + c * 100, 20 + r * 100, <Character of={k} mood={m} size={80} />)}</g>))}</>,
      COLOR.paper,
    );
  })(),
};

for (const [name, content] of Object.entries(files)) writeFileSync(join(out, name), content);
for (const app of ["apps/web/public/icon.svg", "apps/web/app/icon.svg", "apps/approve/public/icon.svg"]) writeFileSync(join(root, app), files["icon.svg"]!);
console.log(`wrote ${Object.keys(files).length} files to packages/brand/assets and the app icons`);
