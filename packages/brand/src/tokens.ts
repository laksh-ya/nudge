/**
 * Nudge's design tokens: the one place colours, type and motion are defined. Both apps and the
 * asset export read from here; docs/BRAND.md explains when to use each.
 */

/** Core colours. Nudge Blue is the brand; Ink and Paper carry most of every screen. */
export const COLOR = {
  /** Nudge's body, links, focus rings, the one bright thing on a calm screen. */
  nudge: "#00BAF2",
  /** Darker Nudge Blue for text on white (meets contrast where the bright blue doesn't). */
  nudgeInk: "#0085C7",
  /** Headlines, the wordmark, character eyes and mouths. Near-black, never pure black. */
  ink: "#1D1D1F",
  /** Body text on Paper. */
  ink2: "#505050",
  /** Marketing background: warm off-white, like Cue's paper. */
  paper: "#F4F4F1",
  /** App surfaces stay white. */
  white: "#FFFFFF",
  /** The app's deep blue, for money figures and dense UI. Kept from the original product. */
  deep: "#002970",
} as const;

/**
 * The cast palette: one colour per character. A new assistant takes the next unused shape and
 * colour from CAST (lib: characters.tsx); never invent a colour outside this list.
 */
export const CAST_COLOR = {
  coral: "#E97B52",
  mint: "#2FB27D",
  sunny: "#FFC21F",
  cherry: "#F2545B",
  grape: "#8E7CF8",
  pebble: "#98A2B3",
} as const;

/** Semantic colours, for states rather than characters. */
export const STATE_COLOR = {
  good: "#0F9D58",
  warn: "#C77700",
  bad: "#EB5757",
} as const;

export const TYPE = {
  /** Interface and display: Mona Sans, wide and heavy for headlines. */
  sans: "Mona Sans",
  /** One accent phrase per headline, in italic. Never body text. */
  serif: "Instrument Serif",
  /** Wordmark: lowercase, weight 900, tracking -0.05em. */
  wordmarkWeight: 900,
} as const;

export const MOTION = {
  /** Every few seconds a character blinks; it's alive, not busy. */
  blinkSeconds: 5.5,
  /** A slow float for the hero and loading screens only. */
  bobSeconds: 3.2,
  /** UI transitions. */
  ease: "cubic-bezier(0.22, 1, 0.36, 1)",
} as const;
