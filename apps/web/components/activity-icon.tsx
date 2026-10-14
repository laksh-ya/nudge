import { ArrowUpRight, Bot, FileDown, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { IconTile } from "./ui";

const icons = {
  payment: ArrowUpRight,
  security: ShieldCheck,
  agent: Bot,
  import: FileDown,
  setting: SlidersHorizontal,
} as const;

const tones = { neutral: "page", good: "green", warn: "amber", bad: "red" } as const;

export function ActivityIcon({
  kind,
  tone,
}: {
  kind: keyof typeof icons;
  tone: keyof typeof tones;
}) {
  return <IconTile icon={icons[kind]} tone={tones[tone]} />;
}
