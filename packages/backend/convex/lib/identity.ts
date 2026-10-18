import { ConvexError } from "convex/values";

/** An invite's email, checked and normalised; empty means an open link anyone with it can redeem. */
export function inviteEmail(raw?: string) {
  const e = (raw ?? "").trim().toLowerCase();
  if (!e) return undefined;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 120) throw new ConvexError("That email doesn't look right");
  return e;
}

/** "priya@gmail.com" -> "p•••a@gmail.com": enough to recognise, not enough to harvest. */
export function maskEmail(e: string) {
  const [local, domain] = e.split("@");
  if (!local || !domain) return e;
  return local.length <= 2 ? `${local[0]}•@${domain}` : `${local[0]}•••${local[local.length - 1]}@${domain}`;
}

/** An invite bound to an email opens only for the account signed in with it (#123). */
export function checkInviteEmail(invited: string | undefined, accepting: string | undefined) {
  if (!invited) return;
  if ((accepting ?? "").trim().toLowerCase() !== invited) {
    throw new ConvexError(`This invite is for ${maskEmail(invited)}. Sign in to Nudge with that email to accept it.`);
  }
}
