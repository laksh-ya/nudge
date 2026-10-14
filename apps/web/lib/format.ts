import { formatMoney, type Currency } from "@agent-wallet/domain";

export { formatMoney };
export type { Currency };

const DAY = 86_400_000;

export function relativeDay(at: number, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const diff = Math.floor((at - start.getTime()) / DAY);
  if (diff === 0) return "Today";
  if (diff === -1) return "Yesterday";
  if (diff === 1) return "Tomorrow";
  if (diff > 1 && diff < 7) return new Date(at).toLocaleDateString("en-IN", { weekday: "long" });
  return new Date(at).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export function dueLabel(at: number, now = Date.now()) {
  const days = Math.round((at - now) / DAY);
  if (days < 0) return "Overdue";
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due in ${days} days`;
}

export function ago(at: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export function time(at: number) {
  return new Date(at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
}

export function shortAddress(address: string) {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
