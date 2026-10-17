import { MONTHS } from "./schedule";

/**
 * The basic assistant's reading of one message, with no model. Deterministic and side-effect free:
 * messages.ts decides what to do with an intent, and every number it answers with comes from the
 * ledger, bills, goals or the user's own words. When in doubt it asks; it never guesses a payee.
 */

/** "USD" is the agent wallet's test dollars; "LOCAL" is the owner's own currency (a bank or UPI payment). */
export type Cur = "USD" | "LOCAL";
export type Amount = { major: number; cur: Cur | null; index: number; end: number };

export type Intent =
  | { kind: "help" }
  | { kind: "greeting" }
  | { kind: "yes" }
  | { kind: "no" }
  | { kind: "hedge" }
  | { kind: "freeze" }
  | { kind: "unfreeze" }
  | { kind: "status" }
  | { kind: "cancel" }
  | { kind: "dont_pay" }
  | { kind: "dont_freeze" }
  /** A payment demand with the usual scam signs (overdue, lose access, verify your…): warned, never carded. */
  | { kind: "scam" }
  /** "pay" inside quoted or pasted text: someone else's words, not an order. */
  | { kind: "quoted" }
  /** "Should I pay X $9 or wait?": advice, not an order. */
  | { kind: "pay_question"; amount: Amount | null }
  | { kind: "correction"; amount: Amount | null; rest: string }
  | {
      kind: "pay";
      amount: Amount | null;
      reason?: string;
      /** A short, direct order in the owner's own words (#59). Only these may pay without a card. */
      direct: boolean;
      /** Corrected within the same message: the amount it replaced, and the words after the correction. */
      corrected?: { from: Amount | null; tail: string };
      /** Says it replaces the open request ("actually…", "…instead"). */
      supersedes?: boolean;
    }
  | { kind: "spending" }
  | { kind: "bills" }
  | { kind: "subscriptions" }
  | { kind: "safe"; amount: Amount | null }
  | { kind: "remind" }
  | { kind: "reminders" }
  | { kind: "reminder_cancel" }
  | { kind: "goal_set"; amount: Amount; name: string | null; question: boolean }
  | { kind: "goal_progress" }
  | { kind: "unknown" };

export function normalize(text: string) {
  return text
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const NUMBER = /(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?/g;
const UNIT_AFTER = /^\s?(?:st|nd|rd|th|am|pm|a\.m|p\.m|:\d|%|\s?(?:days?|weeks?|months?|years?|hours?|hrs?|mins?|minutes?|coffees?|items?|times|x\b|people|of\s|percent))/;
const MONTH_WORD = new RegExp(`\\b(${MONTHS.join("|")}|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\\.?\\s*$`);

/**
 * Money amounts in the text, in order. Dates ("the 1st", "nov 5"), times ("at 6pm"), counts
 * ("2 coffees", "3 days") and years are not amounts. "$", "usd" and "dollars" mean the agent
 * wallet; "₹", "rs", "inr" and "rupees" the owner's own money; "5k" is 5000.
 */
export function amounts(text: string): Amount[] {
  const t = normalize(text);
  const out: Amount[] = [];
  for (const m of t.matchAll(NUMBER)) {
    const index = m.index!;
    let end = index + m[0].length;
    const before = t.slice(Math.max(0, index - 12), index);
    let after = t.slice(end, end + 16);
    if (/[\d.]$/.test(t.slice(0, index))) continue;
    if (UNIT_AFTER.test(after)) continue;
    if (MONTH_WORD.test(before) && !/[$₹]\s?$/.test(before)) continue;
    if (/\b(?:at|by|around)\s$/.test(before) && !/^\s?(k\b|dollars?|bucks|usd|rupees?|rs\b|inr)/.test(after)) continue;
    let major = Number(m[1]!.replace(/,/g, "") + (m[2] ? `.${m[2]}` : ""));
    if (!m[2] && major >= 1990 && major <= 2100 && /\b(in|by|of|since|until|before)\s$/.test(before) && !/^\s?(k\b|dollars?|bucks|usd|rupees?|rs\b|inr)/.test(after)) continue;
    const mult = after.match(/^\s?(k|thousand|lakh|lac|lakhs)\b/);
    if (mult) {
      major *= mult[1] === "k" || mult[1] === "thousand" ? 1000 : 100_000;
      end += mult[0].length;
      after = t.slice(end, end + 16);
    }
    let cur: Cur | null = null;
    if (/(\$|usd|us\$)\s?$/.test(before)) cur = "USD";
    else if (/(₹|rs\.?|inr)\s?$/.test(before)) cur = "LOCAL";
    const suffix = after.match(/^\s?(dollars?|bucks|usd|rupees?|rs\b|inr)/);
    if (suffix) {
      cur = /dollar|buck|usd/.test(suffix[1]!) ? "USD" : "LOCAL";
      end += suffix[0].length;
    }
    if (!Number.isFinite(major) || major <= 0) continue;
    out.push({ major, cur, index, end });
  }
  return out;
}

/** The amount a message means: the first one with a currency, else the first. */
export function pickAmount(list: Amount[]) {
  return list.find((a) => a.cur) ?? list[0] ?? null;
}

/**
 * Only a short, direct order pays on its own (#59). A question, a negation, quoted or pasted text,
 * or more than one number gets an approval card instead: the parser can't tell a request from a quote.
 */
export function isDirectOrder(text: string) {
  const t = text.toLowerCase();
  return (
    text.length <= 80 &&
    /^(please\s+)?(pay|send|transfer)\b/.test(t.trim()) &&
    !/-\s*[$₹€£]?\s*\d|[$₹€£]\s*-\s*\d/.test(text) &&
    !/[\n?"“”‘’`]|'\s|\s'|^'|'$/.test(text.trim()) &&
    !/\b(don'?t|do not|not|never|no|stop|cancel|wait|should|whether|if|maybe|later)\b/.test(t) &&
    (t.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).length === 1
  );
}

/** Words that take back what was just said. */
const MARKER =
  /(?:^|[\s.,;:!—–-])(no,?\s+wait|wait,?\s+no|no,?\s+no|no,?\s+sorry|sorry,?\s+(?:i\s+)?meant|i\s+meant|i\s+mean|actually|scratch\s+that|make\s+it|change\s+(?:it|that)\s+to|oops|correction|instead)\b/;

/**
 * A correction tail that only restates the amount ("no wait, make it $6"). Anything more, and the
 * resolved order is no longer a short direct one, so it goes to the approval card.
 */
const STRICT_TAIL =
  /^[\s.,;:!—–-]*(?:(?:no|nah|wait|actually|sorry|oops|hmm|scratch that|correction)[\s.,;:!—–-]*)*(?:(?:make it|change it to|change that to|i meant|i mean|should be|meant|it's|its)\s+)?(?:\$|usd\s?)?\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?(?:dollars?|usd|bucks))?(?:\s+(?:instead|please|then))?[\s.!]*$/;

export function splitCorrection(text: string): { before: string; after: string } | null {
  const t = normalize(text);
  const first = amounts(t)[0];
  const m = MARKER.exec(t.slice(first ? first.end : 0));
  if (!m) return null;
  const at = (first ? first.end : 0) + m.index;
  const before = t.slice(0, at).replace(/[\s.,;:!—–-]+$/, "");
  const after = t.slice(at);
  if (!before) return null;
  return { before, after };
}

export function isStrictTail(after: string) {
  return STRICT_TAIL.test(normalize(after));
}

const START_MARK = /^(?:no|nah|wait|actually|sorry|oops|scratch that|i meant|i mean|make it|change it to|change that to|correction|not)\b/;
const START_MARK_ALL = /^(?:(?:no|nah|wait|actually|sorry|oops|hmm|ok(?:ay)?|but|scratch that|i meant|i mean|make it|change it to|change that to|correction|not|it'?s|should be)[\s,.!;:—–-]*)+/;
const HEDGE =
  /\b(but wait|ok(?:ay)? but|yes but|hmm+|hold on|hang on|not yet|not now|wait a (?:sec|second|minute|moment)|one (?:sec|second|moment)|let me think|i'?m not sure|not sure|maybe later|give me a (?:sec|second|minute)|let me check|i'?ll think)\b|^(?:wait|hmm+|umm*|uh+|erm|well|maybe)[.!?…]*$/;
const YES = /^(?:yes|yep|yeah|yup|sure|ok|okay|go ahead|do it|confirm(?:ed)?|please do|sounds good|correct|that'?s right|y)(?:[\s,]+(?:please|thanks|thank you|do it|go ahead))*[.!]*$/;
const NO = /^(?:no|nope|nah|cancel|never ?mind|forget it|don'?t|no thanks|no thank you)[.!]*$/;

export function isHedge(text: string) {
  return HEDGE.test(normalize(text));
}
export function isYes(text: string) {
  const t = normalize(text);
  return YES.test(t) && !HEDGE.test(t);
}
export function isNo(text: string) {
  return NO.test(normalize(text));
}

/** "for coffee beans" in a payment order, up to the next amount or correction. */
export function reasonOf(text: string) {
  const m = normalize(text).match(/\bfor\s+((?:(?!\bno\b|\bwait\b|\bactually\b|\bmake it\b)[a-z][a-z '&-]*?))(?=\s*(?:[$₹\d]|\.\.|[.,;!?]|\bno\b|\bwait\b|\bactually\b|$))/);
  const r = m?.[1]?.trim();
  return r && r.length >= 2 && !/^(it|that|this|me|now|today)$/.test(r) ? r.slice(0, 60) : undefined;
}

/** The words naming who to pay, for saying "X isn't one of your contacts". */
export function payeeWords(text: string) {
  const t = normalize(text);
  const m =
    t.match(/\b(?:to|for)\s+([a-z][a-z.' -]{1,30}?)(?=\s+(?:for|now|today|please|from)\b|\s*[$₹\d]|[.,!?]|$)/) ??
    t.match(/\b(?:pay|send|transfer)\s+(?:to\s+)?([a-z][a-z.' -]{1,30}?)(?=\s*[$₹\d]|\s+(?:for|now|today|please|rs|inr|usd)\b|[.,!?]|$)/);
  const w = m?.[1]?.trim().replace(/\b(the|my|a|some|money|cash|it|him|her|them)\b/g, "").trim();
  return w && w.length >= 2 ? w : null;
}

/** Saved contacts the text names: an exact full name wins; otherwise any distinctive name word. */
export function matchContacts<T extends { name: string }>(text: string, contacts: T[]): T[] {
  const t = ` ${normalize(text).replace(/[^\p{L}\p{N}' ]+/gu, " ")} `;
  const full = contacts.filter((c) => t.includes(` ${normalize(c.name).replace(/[^\p{L}\p{N}' ]+/gu, " ")} `));
  if (full.length) {
    const longest = Math.max(...full.map((c) => c.name.length));
    return full.filter((c) => c.name.length === longest || !full.some((o) => o !== c && normalize(o.name).includes(normalize(c.name))));
  }
  const common = new Set(["the", "and", "pay", "send", "bill", "bills", "shop", "store", "india", "ltd", "pvt", "inc", "co"]);
  return contacts.filter((c) =>
    normalize(c.name)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3 && !common.has(w))
      .some((w) => t.includes(` ${w} `)),
  );
}

/** "the first one", "2", "second": an index into the choices just offered. */
export function ordinal(text: string) {
  const t = normalize(text);
  if (/^(?:the\s+)?(?:first|1st|1|one)(?:\s+one)?[.!]*$/.test(t)) return 0;
  if (/^(?:the\s+)?(?:second|2nd|2|two)(?:\s+one)?[.!]*$/.test(t)) return 1;
  if (/^(?:the\s+)?(?:third|3rd|3)(?:\s+one)?[.!]*$/.test(t)) return 2;
  if (/^(?:the\s+)?(?:fourth|4th|4)(?:\s+one)?[.!]*$/.test(t)) return 3;
  return null;
}

/** Which currency an answer to "dollars or rupees?" picks. */
export function currencyWord(text: string): Cur | null {
  const t = normalize(text);
  if (/\$|\bdollars?\b|\busd\b|\bbucks\b|\bwallet\b|\bnudge\b|\bagent\b|\btest\b|\bcrypto\b/.test(t)) return "USD";
  if (/₹|\brupees?\b|\binr\b|\brs\b|\bupi\b|\bbank\b/.test(t)) return "LOCAL";
  return null;
}

const SPEND_Q = /\b(how much|what did i|what have i|total|show|breakdown|where)\b.*\b(spen[dt]|spending|pay for|paid for|did i pay|went on|go on|cost)\b|\b(spen[dt]|spending|expenses?)\b.*\b(on|in|last|this|for|at)\b|^(my )?(spending|expenses)\b|\bspending (summary|breakdown|report)\b/;
const SAFE_Q = /\b(afford|safe to spend|can i spend|could i spend|left to spend|how much (?:can|could|do) i (?:have|spend)|money (?:do i have )?left|available|budget|how much money|what can i spend|spendable)\b/;

/** Classify one message. Payee and category lookups happen in messages.ts, against the owner's data. */
/** The usual signs of a payment scam: urgency, a threat to cut you off, a request to verify or claim. */
const SCAM =
  /\b(legit|scam|phish\w*|fraud\w*|overdue|lose access|suspend\w*|deactivat\w*|verify your|urgent\w*|immediately|final notice|gift ?cards?|lottery|prize|you(?:'ve| have) won|kyc|otp|click (?:the|this) link)\b/;

export function classify(text: string): Intent {
  const t = normalize(text);
  if (!t || /^\/?(help|start)$|^what can you do|^what do you do|^how do(es)? (this|it) work|^commands$/.test(t)) return { kind: "help" };
  const list = amounts(t);
  const amount = pickAmount(list);

  if (/\bremind(?:er)?s?\b/.test(t)) {
    if (/\b(cancel|delete|remove|clear|drop|turn off)\b/.test(t) && !/\bremind me\b/.test(t)) return { kind: "reminder_cancel" };
    if (/^(what|which|show|list|any)\b|\bmy reminders\b|\breminders\??$/.test(t) && !/\bremind me\b/.test(t)) return { kind: "reminders" };
    return { kind: "remind" };
  }
  // "Can you freeze everything now?" is an order too: freezing only tightens, so a polite question counts.
  const polite = /^(?:can|could|would|will) you (?:please\s+)?/.exec(t);
  const order = polite ? t.slice(polite[0].length) : t;
  const raw = polite ? text.trim().replace(/\?+$/, "") : text;
  const controlOrder = /^(?:please\s+)?(?:freeze|unfreeze|unlock|unpause|resume|reactivate|re-?enable|turn back on|panic|emergency stop|stop|lock|pause|halt|block|kill|disable)\b/.test(order) && !/[?\n"“”‘’`]/.test(raw) && !/\b(don'?t|do not|not|never|if|maybe|should|whether)\b/.test(t);
  if (/^(?:no[,.!\s]+)?(?:please\s+)?(?:don'?t|do not|never)\s+(?:freeze|lock|pause|stop|block|disable)\b/.test(t) && !/\b(pay|paying|send|sending|transfer)\b/.test(t)) return { kind: "dont_freeze" };
  if (controlOrder && /\b(unfreeze|unlock|unpause|resume|reactivate|re-?enable|turn back on)\b/.test(t) && /\b(agents?|assistants?|claude|chatgpt|openclaw|hermes|wallet|payments|spending|everything|all|it|them)\b|^(unfreeze|unlock)\b/.test(t)) return { kind: "unfreeze" };
  // Freeze only on a clear order: "freeze", "panic", or stop/lock/pause naming agents or payments.
  // "stop my Netflix subscription" or "lock in rent" must never freeze anything.
  if (controlOrder && /\bfreeze\b|\bpanic\b|\bemergency stop\b/.test(t) && !/\bdon'?t freeze\b|\bunfreeze\b/.test(t)) return { kind: "freeze" };
  if (controlOrder && /\b(stop|lock|pause|halt|block|kill|disable)\b\s+(?:all\s+|every\s+|my\s+|the\s+)*(agents?|assistants?|payments|spending|everything|the wallet|wallet|ai)\b/.test(t)) return { kind: "freeze" };

  const verb = /\b(pay|send|transfer)\b/.test(t);
  if (/^(?:no[,.!\s]+)?(?:don'?t|do not|never)\s+(?:pay|send|transfer)\b|^(?:please\s+)?stop\s+(?:paying|sending)\b/.test(t)) return { kind: "dont_pay" };
  if (verb && SCAM.test(t)) return { kind: "scam" };
  if (HEDGE.test(t) && !amount) return { kind: "hedge" };
  if (YES.test(t)) return { kind: "yes" };
  if (NO.test(t)) return { kind: "no" };

  // A message that only takes back the last request: "no wait, make it $6", "actually $6", "I meant Alex Chen".
  if (!verb && START_MARK.test(t)) {
    const rest = t.replace(START_MARK_ALL, "").trim();
    if (amount || rest) return { kind: "correction", amount, rest };
  }
  if (amount && /^(?:\$|₹|rs\.?\s?)?\d[\d,.]*\s*(?:k|dollars?|rupees?)?\s+instead\b/.test(t)) return { kind: "correction", amount, rest: t };

  if (/\b(status|go(?:ne)? through|went through|get paid|got paid|is it paid|has it been paid|was it paid|did it work|what happened (?:to|with))\b/.test(t) && !/\bbills?\b/.test(t)) return { kind: "status" };
  if (/^(?:please\s+)?(?:cancel|stop|drop)\s+(?:that|it|this|the payment|that payment|the last one|my payment)\b|^cancel[.!]*$/.test(t)) return { kind: "cancel" };

  if (/\b(save|saving|put aside|set aside|goal)\b/.test(t) && amount && !/\b(spen[dt]|saved on)\b/.test(t)) {
    const name = t.match(/\b(?:for|towards?)\s+(?:a\s+|an\s+|my\s+|the\s+|new\s+)*([a-z][a-z0-9 '&-]{1,30}?)(?=\s+(?:by|before|until|in|within|next|this|over|and)\b|[.?!,]|$)/)?.[1] ?? null;
    return { kind: "goal_set", amount, name, question: /\?|\bcan i\b|\bcould i\b|\bis (?:it|that) (?:possible|doable|realistic)\b|\bshould i\b|\bhow much (?:a|per|each) month\b/.test(t) };
  }
  if (/\b(goals?|saved|savings?|saving)\b/.test(t) && !/\bspen[dt]\b/.test(t)) return { kind: "goal_progress" };

  if (SPEND_Q.test(t) && !SAFE_Q.test(t)) return { kind: "spending" };
  if (/\bwhen\b.*\b(due|pay|renew)/.test(t)) return /subscri|renew/.test(t) ? { kind: "subscriptions" } : { kind: "bills" };

  if (verb) {
    // Someone else's words, or a question, is never an order.
    if (/[\n"“”‘’`]|'\s|\s'|^'|'$/.test(text.trim())) return { kind: "quoted" };
    if (!polite && /\?|^(?:should|shall|is|are|was|do|does|did|what|why|when|how|which|whether)\b|\b(?:should i|or wait|whether)\b/.test(t)) return { kind: "pay_question", amount };
    // "actually, pay Blue Tokai $6": a fresh order that replaces the open one.
    if (START_MARK.test(t)) {
      const order = t.replace(START_MARK_ALL, "").trim();
      return { kind: "pay", amount, reason: reasonOf(order), direct: isDirectOrder(order) && !/[\n?"“”]/.test(text), supersedes: true };
    }
    const fix = splitCorrection(t);
    if (fix) {
      const after = amounts(fix.after);
      const before = amounts(fix.before);
      const plain = isDirectOrder(fix.before) && !/[\n?"“”]/.test(text);
      if (after.length === 0 && /^[\s.,;:!—–-]*(?:instead|then)[\s.!]*$/.test(fix.after)) {
        return { kind: "pay", amount: pickAmount(before), reason: reasonOf(fix.before), direct: plain, supersedes: true };
      }
      const corrected = pickAmount(after) ?? pickAmount(before);
      const resolved = corrected && !corrected.cur && pickAmount(before)?.cur ? { ...corrected, cur: pickAmount(before)!.cur } : corrected;
      // Direct only when the tail just restates the amount: "pay X $50 ... no wait, make it $6".
      const direct = plain && after.length > 0 && isStrictTail(fix.after);
      return { kind: "pay", amount: resolved, reason: reasonOf(fix.before), direct, corrected: { from: pickAmount(before), tail: fix.after } };
    }
    return { kind: "pay", amount: list.length > 1 ? null : amount, reason: reasonOf(t), direct: isDirectOrder(text) };
  }

  if (/subscri|\brenew(al|als|s)?\b/.test(t)) return { kind: "subscriptions" };
  if (/\b(bills?|due|upcoming|coming up|rent|emi)\b/.test(t)) return { kind: "bills" };
  if (SAFE_Q.test(t) || /\b(spend|left|money|balance|cash)\b/.test(t)) return { kind: "safe", amount };
  if (/^(hi|hello|hey|hiya|yo|good (morning|afternoon|evening)|thanks|thank you|thx|ty)\b/.test(t)) return { kind: "greeting" };
  return { kind: "unknown" };
}

/** Category words people use, mapped to the categories the ledger uses. */
const SYNONYMS: Record<string, string[]> = {
  food: ["food", "eating out", "restaurants?", "restaurant", "dining", "takeaway", "takeout", "delivery", "coffee", "lunch", "dinner", "breakfast", "meals?"],
  groceries: ["groceries", "grocery", "supermarket", "vegetables"],
  travel: ["travel", "transport", "transportation", "cabs?", "taxis?", "uber", "ola", "commute", "metro", "flights?", "fuel", "petrol"],
  shopping: ["shopping", "clothes", "amazon", "stuff"],
  health: ["health", "medical", "medicine", "pharmacy", "doctor", "hospital"],
  fun: ["fun", "entertainment", "movies?", "cinema", "going out"],
  bills: ["bills", "utilities", "electricity", "phone bill", "internet"],
  rent: ["rent", "housing"],
  subscriptions: ["subscriptions?", "streaming"],
  family: ["family"],
};

/** The ledger category a message names, if any, from the categories this owner actually has. */
export function matchCategory(text: string, categories: string[]) {
  const t = ` ${normalize(text)} `;
  const exact = categories.filter((c) => new RegExp(`\\b${escape(normalize(c))}\\b`).test(t));
  if (exact.length) return exact.sort((a, b) => b.length - a.length)[0]!;
  for (const [key, words] of Object.entries(SYNONYMS)) {
    if (!words.some((w) => new RegExp(`\\b${w}\\b`).test(t))) continue;
    const hit = categories.find((c) => normalize(c) === key) ?? categories.find((c) => normalize(c).includes(key));
    if (hit) return hit;
    return key.charAt(0).toUpperCase() + key.slice(1);
  }
  return null;
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type Period = { from: number; to: number; label: string };

/**
 * The period a spending question means. Month boundaries follow the same clock as the dashboard's
 * overview (lib/overview.ts), so "this month" here matches Money → Spending.
 */
export function parsePeriod(text: string, now: number): Period {
  const t = normalize(text);
  const d = new Date(now);
  const start = (y: number, m: number) => new Date(y, m, 1).getTime();
  const monthName = (y: number, m: number) => `${new Date(y, m, 1).toLocaleString("en-GB", { month: "long" })}${y !== d.getFullYear() ? ` ${y}` : ""}`;
  const y = d.getFullYear();
  const mo = d.getMonth();
  const day0 = new Date(y, mo, d.getDate()).getTime();
  let m: RegExpMatchArray | null;
  if (/\b(last|previous|past) month\b/.test(t)) return { from: start(y, mo - 1), to: start(y, mo), label: `last month (${monthName(new Date(start(y, mo - 1)).getFullYear(), (mo + 11) % 12)})` };
  if ((m = t.match(/\b(?:last|past) (\d{1,3}) days\b/))) return { from: day0 - (Number(m[1]) - 1) * 86_400_000, to: now, label: `in the last ${m[1]} days` };
  if (/\btoday\b/.test(t)) return { from: day0, to: now, label: "today" };
  if (/\byesterday\b/.test(t)) return { from: new Date(y, mo, d.getDate() - 1).getTime(), to: day0, label: "yesterday" };
  if (/\blast week\b/.test(t)) {
    const monday = new Date(y, mo, d.getDate() - ((d.getDay() + 6) % 7)).getTime();
    return { from: monday - 7 * 86_400_000, to: monday, label: "last week" };
  }
  if (/\bthis week\b/.test(t)) {
    const monday = new Date(y, mo, d.getDate() - ((d.getDay() + 6) % 7)).getTime();
    return { from: monday, to: now, label: "this week" };
  }
  if (/\bthis year\b|\bso far this year\b/.test(t)) return { from: new Date(y, 0, 1).getTime(), to: now, label: `this year` };
  if (/\blast year\b/.test(t)) return { from: new Date(y - 1, 0, 1).getTime(), to: new Date(y, 0, 1).getTime(), label: `in ${y - 1}` };
  const named = t.match(/\b(?:in|during|for|of|over)\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b(?:\s+(\d{4}))?/) ?? t.match(/\b(january|february|march|april|june|july|august|september|october|november|december)\b(?:\s+(\d{4}))?/);
  if (named) {
    const idx = MONTHS.findIndex((x) => x.startsWith(named[1]!.slice(0, 3)));
    let yy = named[2] ? Number(named[2]) : y;
    if (!named[2] && idx > mo) yy -= 1;
    return { from: start(yy, idx), to: Math.min(start(yy, idx + 1), now), label: `in ${monthName(yy, idx)}` };
  }
  return { from: start(y, mo), to: now, label: `this month (${monthName(y, mo)})` };
}
