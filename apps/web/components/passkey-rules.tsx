import { Clock, Fingerprint, Zap } from "lucide-react";

/** One place that says which actions need the passkey. Tightening is instant; loosening needs you. */
const RULES = [
  {
    icon: Zap,
    tone: "bg-green-soft text-green",
    title: "Instant, no passkey",
    items: [
      "An agent paying a trusted contact within the limits you signed",
      "Freezing an agent or everything",
      "Lowering an agent's limits, or removing a contact",
      "Stopping a held payment, or declining any request",
      "Reminders, bills, plans and goals",
    ],
  },
  {
    icon: Fingerprint,
    tone: "bg-sky text-navy",
    title: "Your passkey, once",
    items: [
      "Any payment above an agent's limit, or to someone not yet trusted",
      "Making someone a trusted contact",
      "Giving an agent limits, or raising them",
      "Withdrawing from the wallet, or unfreezing",
      "Changing the wallet's daily ceiling or protected amount",
    ],
  },
  {
    icon: Clock,
    tone: "bg-amber-soft text-amber",
    title: "Passkey, then a short wait",
    items: ["On an on-chain wallet, anything that loosens a rule waits the vault's delay (a few minutes), and you can cancel it until then"],
  },
];

export function PasskeyRules() {
  return (
    <details className="group px-4 pb-3">
      <summary className="press flex cursor-pointer list-none items-center justify-between py-2.5 text-body font-medium text-ink">
        What needs your passkey
        <span className="text-label font-semibold text-cyan-ink group-open:hidden">Show</span>
      </summary>
      <div className="space-y-3 pb-1">
        {RULES.map((r) => (
          <div key={r.title} className="flex gap-3">
            <span className={`grid size-8 shrink-0 place-items-center rounded-[10px] ${r.tone}`}>
              <r.icon className="size-4" />
            </span>
            <div>
              <div className="text-body font-semibold">{r.title}</div>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-label text-ink-2">
                {r.items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}
