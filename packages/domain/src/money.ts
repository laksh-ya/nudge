export const CURRENCIES = {
  INR: { symbol: "₹", decimals: 2, locale: "en-IN" },
  CNY: { symbol: "¥", decimals: 2, locale: "zh-CN" },
  USD: { symbol: "$", decimals: 2, locale: "en-US" },
  USDC: { symbol: "$", decimals: 2, locale: "en-US" },
  EUR: { symbol: "€", decimals: 2, locale: "en-IE" },
  GBP: { symbol: "£", decimals: 2, locale: "en-GB" },
} as const;

export type Currency = keyof typeof CURRENCIES;

/** Amounts are integers in the currency's minor unit (paise, fen, cents). */
export function formatMoney(
  minor: number,
  currency: Currency,
  opts: { sign?: boolean; compact?: boolean; cents?: boolean } = {},
): string {
  const meta = CURRENCIES[currency];
  const major = Math.abs(minor) / 10 ** meta.decimals;
  const dollarLike = currency === "USD" || currency === "USDC";
  const showCents = opts.cents ?? (dollarLike || !Number.isInteger(major));
  const body = new Intl.NumberFormat(meta.locale, {
    notation: opts.compact ? "compact" : "standard",
    minimumFractionDigits: showCents && !opts.compact ? meta.decimals : 0,
    maximumFractionDigits: opts.compact ? 1 : showCents ? meta.decimals : 0,
  }).format(major);
  const sign = minor < 0 ? "−" : opts.sign && minor > 0 ? "+" : "";
  return `${sign}${meta.symbol}${body}`;
}

export function toMinor(major: number, currency: Currency): number {
  return Math.round(major * 10 ** CURRENCIES[currency].decimals);
}
