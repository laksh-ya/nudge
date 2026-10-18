/**
 * Wall-clock time in the owner's time zone: quiet hours, "remind me on the 1st", "due tomorrow".
 * Pure functions, so the reminder cron and the chat parser agree and can be tested without a clock.
 */

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export type Local = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

const formats = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** A time zone the runtime knows, or UTC. */
export function safeTz(tz?: string | null) {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** What the wall clock in `tz` reads at `at`. Month is 0-based, weekday 0 = Sunday. */
export function local(at: number, tz: string): Local {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formats.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(at)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month) - 1,
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    weekday: WEEKDAYS.indexOf((p.weekday ?? "").slice(0, 3).toLowerCase()),
  };
}

/** The instant the wall clock in `tz` reads this date and time. Days and months may overflow, as with Date.UTC. */
export function zoned(year: number, month: number, day: number, hour: number, minute: number, tz: string) {
  const want = Date.UTC(year, month, day, hour, minute);
  let at = want;
  for (let i = 0; i < 3; i++) {
    const l = local(at, tz);
    const seen = Date.UTC(l.year, l.month, l.day, l.hour, l.minute);
    if (seen === want) break;
    at += want - seen;
  }
  return at;
}

export function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Calendar days from `now` to `at` in the owner's zone: 0 today, 1 tomorrow, -1 yesterday. */
export function daysUntil(at: number, now: number, tz: string) {
  const a = local(at, tz);
  const b = local(now, tz);
  return Math.round((Date.UTC(a.year, a.month, a.day) - Date.UTC(b.year, b.month, b.day)) / DAY);
}

export function dateLabel(at: number, tz: string, withTime = false) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const } : {}),
  })
    .format(at)
    .replace(/,(?=\s\d{2}:)/, " at");
}

/** "today", "tomorrow", "in 3 days", "on Sat 1 Nov"; "2 days ago" for overdue. */
export function whenWords(at: number, now: number, tz: string) {
  const d = daysUntil(at, now, tz);
  if (d < 0) return d === -1 ? "yesterday" : `${-d} days ago`;
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d < 7) return `in ${d} days`;
  return `on ${dateLabel(at, tz)}`;
}

function minutesOf(s?: string | null) {
  const m = s?.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/**
 * The owner's quiet hours, or null: one rule for every screen, the scheduler and MCP (#103). Unset,
 * empty, malformed or an equal start and end all mean none.
 */
export function quietHoursOf(u: { quietFrom?: string | null; quietTo?: string | null }): { from: string; to: string } | null {
  const f = minutesOf(u.quietFrom);
  const t = minutesOf(u.quietTo);
  return f === null || t === null || f === t ? null : { from: u.quietFrom!, to: u.quietTo! };
}

/**
 * Whether `at` falls in the owner's quiet hours. A window that crosses midnight (22:00 to 07:00)
 * wraps; an equal start and end, or a missing one, means no quiet hours.
 */
export function inQuietHours(at: number, tz: string, from?: string | null, to?: string | null) {
  const f = minutesOf(from);
  const t = minutesOf(to);
  if (f === null || t === null || f === t) return false;
  const l = local(at, tz);
  const m = l.hour * 60 + l.minute;
  return f < t ? m >= f && m < t : m >= f || m < t;
}

/** The first moment after `at` that is outside quiet hours (or `at` itself). */
export function afterQuietHours(at: number, tz: string, from?: string | null, to?: string | null) {
  let t = at;
  for (let i = 0; i < 48 * 4 && inQuietHours(t, tz, from, to); i++) t += 15 * MINUTE;
  return t;
}

const WORD_NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10 };

/** "at 6pm", "at 18:30", "at 9", "in the morning", "tonight". */
export function parseTime(t: string): { h: number; m: number } | null {
  const m = t.match(/\b(?:at|by|around)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?=\W|$)/) ?? t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (m) {
    let h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    const ap = m[3]?.replace(/\./g, "");
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h < 24 && min < 60) return { h, m: min };
  }
  if (/\bnoon\b|\bmidday\b/.test(t)) return { h: 12, m: 0 };
  if (/\btonight\b|\bthis evening\b|\bin the evening\b/.test(t)) return { h: 20, m: 0 };
  if (/\bafternoon\b/.test(t)) return { h: 15, m: 0 };
  if (/\bmorning\b/.test(t)) return { h: 9, m: 0 };
  return null;
}

/** How a reminder repeats, if the text says so. */
export function parseRepeat(t: string): "monthly" | "weekly" | undefined {
  if (/\b(every|each)\s+month\b|\bmonthly\b|\bevery\s+\d{1,2}(st|nd|rd|th)\b/.test(t)) return "monthly";
  if (/\b(every|each)\s+(week|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|\bweekly\b/.test(t)) return "weekly";
  return undefined;
}

const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
export function monthIndex(word: string) {
  return MONTHS.findIndex((m) => m.startsWith(word.toLowerCase().slice(0, 3)));
}

/**
 * When a reminder should fire, from the owner's words: "on the 1st", "tomorrow at 6pm",
 * "in 3 days", "on friday", "on 5 nov", "next week". Null when the text names no time.
 * Times without an hour default to 09:00 in the owner's zone; a time already past moves forward.
 */
export function parseWhen(text: string, now: number, tzIn?: string | null): number | null {
  const tz = safeTz(tzIn);
  const t = text.toLowerCase();
  const n = local(now, tz);
  const time = parseTime(t);
  const h = time?.h ?? 9;
  const mi = time?.m ?? 0;
  const at = (y: number, mo: number, d: number) => zoned(y, mo, d, h, mi, tz);
  const monthDay = (y: number, mo: number, d: number) => at(y, mo, Math.min(d, daysInMonth(y + Math.floor(mo / 12), ((mo % 12) + 12) % 12)));
  let m: RegExpMatchArray | null;

  if ((m = t.match(/\bin\s+(\d+|an?|one|two|three|four|five|six|seven|ten)\s+(minute|min|hour|hr|day|week|month)s?\b/))) {
    const k = /^\d+$/.test(m[1]!) ? Number(m[1]) : (WORD_NUMBERS[m[1]!] ?? 1);
    const unit = m[2]!;
    if (unit.startsWith("min")) return now + k * MINUTE;
    if (unit.startsWith("h")) return now + k * HOUR;
    if (unit === "day") return at(n.year, n.month, n.day + k);
    if (unit === "week") return at(n.year, n.month, n.day + 7 * k);
    return monthDay(n.year, n.month + k, n.day);
  }
  if (/\btomorrow\b/.test(t)) return at(n.year, n.month, n.day + 1);
  if (/\bnext week\b/.test(t)) return at(n.year, n.month, n.day + 7);
  if (/\bnext month\b/.test(t)) return at(n.year, n.month + 1, 1);

  // "on 5 nov", "5th of november", "nov 5", "november 5th"
  if ((m = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MONTH_RE}\\b`))) || (m = t.match(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`)))) {
    const [day, word] = /^\d/.test(m[1]!) ? [Number(m[1]), m[2]!] : [Number(m[2]), m[1]!];
    const mo = monthIndex(word);
    if (day >= 1 && day <= 31 && mo >= 0) {
      let when = monthDay(n.year, mo, day);
      if (when <= now) when = monthDay(n.year + 1, mo, day);
      return when;
    }
  }
  // "on the 1st", "on 15th", "every 1st"
  if ((m = t.match(/\b(?:on|every|by)\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\b/) ?? t.match(/\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/))) {
    const day = Number(m[1]);
    if (day >= 1 && day <= 31) {
      let when = monthDay(n.year, n.month, day);
      if (when <= now) when = monthDay(n.year, n.month + 1, day);
      return when;
    }
  }
  if ((m = t.match(/\b(?:on\s+|next\s+|this\s+|every\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|tues|thurs|sun|mon|tue|wed|thu|fri|sat)\b/))) {
    const wd = WEEKDAYS.indexOf(m[1]!.slice(0, 3));
    let ahead = (wd - n.weekday + 7) % 7;
    let when = at(n.year, n.month, n.day + ahead);
    if (when <= now) {
      ahead += 7;
      when = at(n.year, n.month, n.day + ahead);
    }
    return when;
  }
  if (/\btoday\b|\btonight\b|\bthis (?:evening|afternoon|morning)\b/.test(t) || time) {
    let when = at(n.year, n.month, n.day);
    if (when <= now) when = /\btoday\b|\btonight\b/.test(t) && !time ? now + 5 * MINUTE : at(n.year, n.month, n.day + 1);
    return when;
  }
  return null;
}

/** The next time a repeating reminder fires after `at`. */
export function nextRepeat(at: number, repeat: "monthly" | "weekly", tzIn?: string | null, anchorDay?: number) {
  const tz = safeTz(tzIn);
  const l = local(at, tz);
  if (repeat === "weekly") return zoned(l.year, l.month, l.day + 7, l.hour, l.minute, tz);
  const y = l.year + (l.month === 11 ? 1 : 0);
  const mo = (l.month + 1) % 12;
  return zoned(y, mo, Math.min(anchorDay ?? l.day, daysInMonth(y, mo)), l.hour, l.minute, tz);
}

/** "by December", "by march 2027", "in 6 months", "by next year": the last moment of that period. */
export function parseDeadline(text: string, now: number, tzIn?: string | null): number | null {
  const tz = safeTz(tzIn);
  const t = text.toLowerCase();
  const n = local(now, tz);
  const endOf = (y: number, mo: number) => zoned(y, mo, daysInMonth(y + Math.floor(mo / 12), ((mo % 12) + 12) % 12), 23, 59, tz);
  let m: RegExpMatchArray | null;
  if ((m = t.match(/\bin\s+(\d+|a|an|one|two|three|six)\s+(month|week|year)s?\b/))) {
    const k = /^\d+$/.test(m[1]!) ? Number(m[1]) : (WORD_NUMBERS[m[1]!] ?? 1);
    if (m[2] === "week") return zoned(n.year, n.month, n.day + 7 * k, 23, 59, tz);
    if (m[2] === "year") return zoned(n.year + k, n.month, n.day, 23, 59, tz);
    return zoned(n.year, n.month + k, n.day, 23, 59, tz);
  }
  if (/\b(by|before|until)\s+next\s+year\b/.test(t)) return endOf(n.year + 1, 0);
  if (/\b(by|before|until)\s+(the\s+)?end\s+of\s+(the\s+)?year\b/.test(t)) return endOf(n.year, 11);
  if (/\b(by|before|until)\s+next\s+month\b/.test(t)) return endOf(n.year, n.month + 1);
  if ((m = t.match(new RegExp(`\\b(?:by|before|until|in|for)\\s+(?:the\\s+end\\s+of\\s+)?${MONTH_RE}(?:\\s+(\\d{4}))?\\b`)))) {
    const mo = monthIndex(m[1]!);
    if (mo >= 0) {
      let y = m[2] ? Number(m[2]) : n.year;
      if (!m[2] && mo < n.month) y += 1;
      return endOf(y, mo);
    }
  }
  return null;
}
