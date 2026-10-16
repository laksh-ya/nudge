export const CURRENCIES = {
  INR: { symbol: "₹", decimals: 2, locale: "en-IN" },
  CNY: { symbol: "¥", decimals: 2, locale: "zh-CN" },
  USD: { symbol: "$", decimals: 2, locale: "en-US" },
  USDC: { symbol: "$", decimals: 2, locale: "en-US" },
  EUR: { symbol: "€", decimals: 2, locale: "en-IE" },
  GBP: { symbol: "£", decimals: 2, locale: "en-GB" },
  SGD: { symbol: "S$", decimals: 2, locale: "en-SG" },
  AED: { symbol: "AED ", decimals: 2, locale: "en-AE" },
  JPY: { symbol: "¥", decimals: 0, locale: "ja-JP" },
  HKD: { symbol: "HK$", decimals: 2, locale: "en-HK" },
  AUD: { symbol: "A$", decimals: 2, locale: "en-AU" },
  CAD: { symbol: "C$", decimals: 2, locale: "en-CA" },
} as const;

export const CURRENCY_CODES = Object.keys(CURRENCIES) as Currency[];
export const FIAT_CODES = CURRENCY_CODES.filter((c) => c !== "USDC");

/** Convert between currencies with USD-based rates (units of currency per 1 USD). */
export function convert(minor: number, from: Currency, to: Currency, usdRates: Record<string, number>): number {
  if (from === to) return minor;
  const f = from === "USDC" ? 1 : usdRates[from];
  const t = to === "USDC" ? 1 : usdRates[to];
  // A missing or nonsensical rate is an error, never a silent zero.
  if (!(f && f > 0 && Number.isFinite(f))) throw new Error(`No exchange rate for ${from}`);
  if (!(t && t > 0 && Number.isFinite(t))) throw new Error(`No exchange rate for ${to}`);
  const major = minor / 10 ** CURRENCIES[from].decimals;
  return Math.round((major / f) * t * 10 ** CURRENCIES[to].decimals);
}

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

export function decimalsOf(currency: Currency) {
  return CURRENCIES[currency].decimals;
}

export function toMinor(major: number, currency: Currency): number {
  return Math.round(major * 10 ** CURRENCIES[currency].decimals);
}

/** Used until the first live rate fetch. ECB reference rates, 14 Oct 2026; AED is pegged. */
export const FALLBACK_USD_RATES: Record<string, number> = {
  USD: 1,
  USDC: 1,
  INR: 95.16,
  CNY: 6.6927,
  EUR: 0.89326,
  GBP: 0.75377,
  SGD: 1.2826,
  AED: 3.6725,
  JPY: 158.45,
  HKD: 7.8481,
  AUD: 1.4266,
  CAD: 1.4219,
};
