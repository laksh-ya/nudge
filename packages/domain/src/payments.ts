/** One lifecycle for every payment, whichever surface started it. */
export const PAYMENT_STATES = [
  "drafted",
  "needs_info",
  "checked",
  "awaiting_approval",
  "reserved",
  "submitted",
  "confirmed",
  "failed",
  "cancelled",
  "expired",
  "unknown",
  "queued",
  "held",
  "reported",
] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];

export const TERMINAL_STATES: readonly PaymentState[] = ["confirmed", "failed", "cancelled", "expired", "reported"];

export const STATE_LABEL: Record<PaymentState, string> = {
  drafted: "Draft",
  needs_info: "Needs details",
  checked: "Checked",
  awaiting_approval: "Needs your approval",
  reserved: "Reserved",
  submitted: "Sending",
  confirmed: "Paid",
  failed: "Failed",
  cancelled: "Cancelled",
  expired: "Expired",
  unknown: "Checking outcome",
  queued: "Waiting to apply",
  held: "Held, cancellable",
  reported: "You marked it paid",
};
