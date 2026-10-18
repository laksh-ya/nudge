/** Where approval links point. One place, so a wrong or old value can't send owners elsewhere (#110). */
export const APPROVE_ORIGIN = "https://approve.heynudge.live";
/**
 * Approval hosts new links must not use. nudge-approve.vercel.app still serves the page for wallets whose
 * passkey was made there (a passkey only signs on its own site); the page sends each wallet to its own
 * host, so links can always start at APPROVE_ORIGIN.
 */
const RETIRED = new Set(["agent-wallet-approve.vercel.app", "nudge-approve.vercel.app"]);

export function approveBase() {
  const raw = process.env.APPROVE_URL?.trim();
  if (!raw) return APPROVE_ORIGIN;
  try {
    const u = new URL(raw);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (RETIRED.has(u.hostname) || (u.protocol !== "https:" && !local)) {
      console.error(`APPROVE_URL ${u.origin} is retired or not https; using ${APPROVE_ORIGIN}`);
      return APPROVE_ORIGIN;
    }
    return u.origin;
  } catch {
    console.error(`APPROVE_URL is not a URL; using ${APPROVE_ORIGIN}`);
    return APPROVE_ORIGIN;
  }
}

export const approveLink = (token: string) => `${approveBase()}/a/${token}`;
