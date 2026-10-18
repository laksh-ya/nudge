import { Clock, Fingerprint, Zap } from "lucide-react";

/** One place that says which actions need the passkey. Tightening is instant; loosening needs you. */
const RULES = [
  {
    icon: Zap,
    tone: "bg-green-soft text-green",
    title: "Instant, no passkey",
    items: [
      "An agent paying a trusted contact within the limits you signed",
      "Connecting a new assistant: it can see your money and ask, but every payment comes to you until you give it limits",
      "Freezing an agent or everything, lowering an agent's limits, removing a contact",
      "Stopping a held payment, or declining any request",
      "Reminders, bills, plans, goals and quiet hours",
    ],
  },
  {
    icon: Fingerprint,
    tone: "bg-sky text-navy",
    title: "Your passkey, once",
    items: [
      "A payment above an agent's limit",
      "Giving an assistant limits to pay on its own, or raising them (also when it asks through a link)",
      "Making someone a trusted contact, so agents may pay them alone (after your new-contact wait)",
      "Withdrawing from the wallet, or unfreezing",
    ],
  },
  {
    icon: Clock,
    tone: "bg-amber-soft text-amber",
    title: "Passkey, then your vault's change delay",
    items: [
      "Paying someone who isn't saved in your vault: one passkey pays them once (it doesn't make them trusted), and you can cancel it during the delay",
      "Loosening any rule: a higher daily ceiling, a lower protected amount, shorter waits",
      "On a simulated wallet there is no delay; set both waits in Wallet → Rules and limits",
    ],
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
