/**
 * Statement parsing shared by every import path (CSV, Excel, PDF text, OCR text).
 * Pure functions: they turn rows of strings into transactions the user reviews before posting.
 */

export type Field = "date" | "description" | "amount" | "debit" | "credit" | "balance" | "currency" | "direction" | "status";

export type Mapping = Partial<Record<Field, number>>;

export type ParsedRow = {
  at: number;
  amountMinor: number;
  description: string;
  balanceMinor?: number;
  currency?: string;
  pending?: boolean;
};

const SYNONYMS: Record<Field, RegExp> = {
  date: /^(date|txn date|transaction date|value date|value dt|posting date|post date|started date|completed date|booking date|time|timestamp|交易时间|交易日期|记账日期|日期|时间)$/i,
  description: /^(description|narration|details|particulars|transaction details|merchant|name|payee|remarks|memo|reference|交易对方|商品说明|商品|交易说明|摘要|对方户名|备注)$/i,
  amount: /^(amount|amount \(.*\)|transaction amount|gross|net|value|金额|金额\(元\)|金额（元）|交易金额)$/i,
  debit: /^(debit|debits|withdrawal|withdrawal amt\.?|withdrawals|paid out|money out|dr|debit amount|支出)$/i,
  credit: /^(credit|credits|deposit|deposit amt\.?|deposits|paid in|money in|cr|credit amount|收入)$/i,
  balance: /^(balance|closing balance|running balance|available balance|余额|账户余额)$/i,
  currency: /^(currency|ccy|币种)$/i,
  direction: /^(收\/支|收支|dr\/cr|cr\/dr|debit\/credit)$/i,
  status: /^(status|state|交易状态|当前状态)$/i,
};

function clean(h: string) {
  return h.replace(/^﻿/, "").replace(/\s+/g, " ").trim();
}

/** Bank exports often start with account details; find the row that looks like a header. */
export function findHeaderRow(rows: string[][]): number {
  let best = 0;
  let bestScore = 0;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const row = rows[i] ?? [];
    const score = row.reduce((s, cell) => {
      const c = clean(cell ?? "");
      return s + (Object.values(SYNONYMS).some((re) => re.test(c)) ? 1 : 0);
    }, 0);
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

export function guessMapping(headers: string[]): Mapping {
  const m: Mapping = {};
  headers.forEach((raw, i) => {
    const h = clean(raw ?? "");
    for (const field of Object.keys(SYNONYMS) as Field[]) {
      if (m[field] === undefined && SYNONYMS[field].test(h)) {
        // "Type" is too generic unless no better direction column exists.
        m[field] = i;
        break;
      }
    }
  });
  if (m.amount !== undefined && (m.debit !== undefined || m.credit !== undefined)) delete m.amount;
  return m;
}

/** Parse "1,23,456.78", "(45.00)", "-12", "₹ 500 Dr", "¥1,234.00", "1.234,56". */
export function parseAmount(input: string | number | undefined): number | null {
  if (input === undefined || input === null) return null;
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  let s = String(input).trim();
  if (!s || s === "-" || s === "--") return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  if (/\bdr\.?$/i.test(s)) {
    sign = -1;
    s = s.replace(/\bdr\.?$/i, "");
  }
  s = s.replace(/\bcr\.?$/i, "");
  s = s.replace(/[^\d.,\-+]/g, "");
  if (s.startsWith("-")) {
    sign *= -1;
    s = s.slice(1);
  } else if (s.startsWith("+")) s = s.slice(1);
  // European format: 1.234,56
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  if (!/^\d*\.?\d+$/.test(s)) return null;
  return sign * Number(s);
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** Parse common statement date formats. Returns local-midnight-ish epoch ms, or null. */
export function parseDate(input: string | number | Date | undefined, order: "dmy" | "mdy" | "ymd" = "dmy"): number | null {
  if (input === undefined || input === null || input === "") return null;
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input.getTime();
  if (typeof input === "number") {
    // Excel serial date
    if (input > 20000 && input < 80000) return Math.round((input - 25569) * 86_400_000);
    return null;
  }
  const s = String(input).trim().replace(/\s+/g, " ");
  let m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 12), +(m[5] ?? 0));
  m = s.match(/^(\d{1,2})[-/. ]([A-Za-z]{3,9})[-/. ,]*(\d{2,4})/);
  if (m) {
    const mon = MONTHS[m[2]!.slice(0, 3).toLowerCase()];
    if (mon === undefined) return null;
    const y = +m[3]! < 100 ? 2000 + +m[3]! : +m[3]!;
    return Date.UTC(y, mon, +m[1]!, 12);
  }
  m = s.match(/^([A-Za-z]{3,9}) (\d{1,2}),? (\d{4})/);
  if (m) {
    const mon = MONTHS[m[1]!.slice(0, 3).toLowerCase()];
    if (mon === undefined) return null;
    return Date.UTC(+m[3]!, mon, +m[2]!, 12);
  }
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    let a = +m[1]!;
    let b = +m[2]!;
    const y = +m[3]! < 100 ? 2000 + +m[3]! : +m[3]!;
    if (order === "mdy" && a <= 12) [a, b] = [b, a];
    else if (a <= 12 && b > 12) [a, b] = [b, a];
    if (b < 1 || b > 12 || a < 1 || a > 31) return null;
    return Date.UTC(y, b - 1, a, 12);
  }
  return null;
}

const INCOME_WORDS = /^(收入|income|credit|cr|deposit|in)$/i;
const SPEND_WORDS = /^(支出|expense|debit|dr|withdrawal|out|payment|purchase)$/i;
const SKIP_STATUS = /(关闭|失败|已退款|退款成功|failed|declined|cancel|reversed|void)/i;

/** Turn data rows into transactions using a column mapping. */
export function rowsToTransactions(
  rows: string[][],
  mapping: Mapping,
  opts: { order?: "dmy" | "mdy" | "ymd"; decimals?: number; flipSign?: boolean } = {},
): ParsedRow[] {
  const decimals = opts.decimals ?? 2;
  const scale = 10 ** decimals;
  const out: ParsedRow[] = [];
  for (const row of rows) {
    const get = (f: Field) => (mapping[f] === undefined ? undefined : row[mapping[f]!]);
    const at = parseDate(get("date"), opts.order);
    if (at === null) continue;
    const status = get("status") ?? "";
    if (SKIP_STATUS.test(status)) continue;
    let amount: number | null = null;
    if (mapping.amount !== undefined) {
      amount = parseAmount(get("amount"));
      const dir = (get("direction") ?? "").trim();
      if (amount !== null && dir) {
        if (INCOME_WORDS.test(dir)) amount = Math.abs(amount);
        else if (SPEND_WORDS.test(dir)) amount = -Math.abs(amount);
        else if (/不计收支|neutral/i.test(dir)) continue;
      }
    } else {
      const debit = parseAmount(get("debit"));
      const credit = parseAmount(get("credit"));
      if (debit) amount = -Math.abs(debit);
      else if (credit) amount = Math.abs(credit);
    }
    if (amount === null || amount === 0) continue;
    if (opts.flipSign) amount = -amount;
    const balance = parseAmount(get("balance"));
    out.push({
      at,
      amountMinor: Math.round(amount * scale),
      description: (get("description") ?? "").trim() || "Unknown",
      balanceMinor: balance === null ? undefined : Math.round(balance * scale),
      currency: get("currency")?.trim().toUpperCase() || undefined,
      pending: /pending|processing|处理中|待/i.test(status) || undefined,
    });
  }
  return out;
}

/**
 * Parse free text lines (from a PDF or OCR) shaped like
 * "05/10/2026  SWIGGY BANGALORE   389.00   84,250.00".
 * When a running balance is present, its movement decides whether a row is money in or out.
 */
export function linesToTransactions(lines: string[], order: "dmy" | "mdy" | "ymd" = "dmy", decimals = 2): ParsedRow[] {
  const scale = 10 ** decimals;
  const dateRe = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/. ](?:\d{1,2}|[A-Za-z]{3,9})[-/. ,]*\d{2,4})/;
  const amountRe = /\(?-?[₹$¥€£]?\s?\d{1,3}(?:[,]\d{2,3})*(?:\.\d{1,2})\)?(?:\s?(?:Dr|Cr|DR|CR))?/g;
  const rows: { at: number; desc: string; nums: number[]; raw: string }[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    const d = line.match(dateRe);
    if (!d) continue;
    const at = parseDate(d[1], order);
    if (at === null) continue;
    const rest = line.slice(d[0].length);
    const amounts = [...rest.matchAll(amountRe)].map((x) => x[0]);
    if (amounts.length === 0) continue;
    const nums = amounts.map((a) => parseAmount(a)).filter((n): n is number => n !== null);
    const firstAmountIdx = rest.indexOf(amounts[0]!);
    const desc = rest
      .slice(0, firstAmountIdx)
      .replace(dateRe, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    rows.push({ at, desc: desc || "Unknown", nums, raw: line });
  }
  const out: ParsedRow[] = [];
  let prevBalance: number | undefined;
  for (const r of rows) {
    let amount = r.nums[0]!;
    let balance: number | undefined;
    if (r.nums.length >= 2) {
      balance = r.nums[r.nums.length - 1]!;
      amount = r.nums[r.nums.length - 2]!;
      if (prevBalance !== undefined) {
        const delta = balance - prevBalance;
        if (Math.abs(Math.abs(delta) - Math.abs(amount)) < 0.01) amount = delta;
        else amount = -Math.abs(amount);
      } else if (!/\bcr\b/i.test(r.raw) && amount > 0) {
        amount = -Math.abs(amount);
      }
      prevBalance = balance;
    } else if (/\bcr\b/i.test(r.raw)) {
      amount = Math.abs(amount);
    } else if (amount > 0) {
      amount = -amount;
    }
    if (amount === 0) continue;
    out.push({
      at: r.at,
      amountMinor: Math.round(amount * scale),
      description: r.desc,
      balanceMinor: balance === undefined ? undefined : Math.round(balance * scale),
    });
  }
  return out;
}

/** Pull the likely total, date and merchant out of OCR text from a receipt. */
export function parseReceipt(text: string, order: "dmy" | "mdy" | "ymd" = "dmy") {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const merchant = lines.find((l) => /[A-Za-z一-鿿]{3,}/.test(l) && !/receipt|invoice|tax|gst|bill no|date/i.test(l)) ?? "";
  let total: number | null = null;
  for (const l of lines) {
    if (/(grand total|total amount|amount due|net payable|total|合计|总计|实付)/i.test(l)) {
      const nums = [...l.matchAll(/\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?/g)].map((m) => parseAmount(m[0])).filter((n): n is number => n !== null);
      if (nums.length) total = Math.max(total ?? 0, ...nums);
    }
  }
  if (total === null) {
    const all = [...text.matchAll(/\d{1,3}(?:,\d{2,3})*\.\d{2}/g)].map((m) => parseAmount(m[0])).filter((n): n is number => n !== null);
    if (all.length) total = Math.max(...all);
  }
  let at: number | null = null;
  for (const l of lines) {
    const d = l.match(/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2} [A-Za-z]{3,9},? \d{2,4})/);
    if (d) {
      at = parseDate(d[1], order);
      if (at) break;
    }
  }
  return { merchant: merchant.slice(0, 48), total, at };
}
