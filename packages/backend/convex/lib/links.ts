/** Where approval links point. One place, so a wrong or old value can't send owners elsewhere (#110). */
export const APPROVE_ORIGIN = "https://nudge-approve.vercel.app";
/** Origins approval links must never use again (passkeys there belong to retired setups). */
const RETIRED = new Set(["agent-wallet-approve.vercel.app"]);

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
