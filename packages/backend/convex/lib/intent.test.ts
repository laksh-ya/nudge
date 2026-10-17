import { describe, expect, it } from "vitest";
import { amounts, classify, isHedge, isYes, matchCategory, matchContacts, parsePeriod, pickAmount, reasonOf, splitCorrection } from "./intent";
import { afterQuietHours, daysUntil, inQuietHours, local, nextRepeat, parseDeadline, parseWhen, whenWords } from "./schedule";
import { reminderWhat } from "./assist";

// The basic assistant (no model key, as on prod) reading ordinary messages. Issue #17 and audit U25/U26.

describe("what each message means", () => {
  const cases: [string, string, Record<string, unknown>?][] = [
    // payments
    ["Pay Blue Tokai $4 for coffee", "pay", { direct: true }],
    ["send alex 10", "pay", { direct: true }],
    ["transfer 5 dollars to Exa", "pay"],
    ["Should I pay Blue Tokai $9 or wait until next month?", "pay", { direct: false }],
    ["Pay Blue Tokai for 2 coffees at $4 each", "pay", { direct: false }],
    // corrections
    ["pay blue tokai $50 for beans... no wait, make it $6", "pay", { direct: true }],
    ["Pay Blue Tokai $50 actually make it $6 and also add a tip", "pay", { direct: false }],
    ["no wait, make it $6", "correction"],
    ["actually $6", "correction"],
    ["I meant Alex Chen", "correction"],
    ["$6 instead", "correction"],
    ["actually, pay Blue Tokai $6", "pay", { supersedes: true, direct: true }],
    // hedges are never a yes
    ["ok but wait", "hedge"],
    ["hmm", "hedge"],
    ["not yet", "hedge"],
    ["yes but not yet", "hedge"],
    ["hold on", "hedge"],
    ["wait", "hedge"],
    ["ok", "yes"],
    ["yes please", "yes"],
    ["no", "no"],
    // finance questions
    ["how much did I spend on food last month?", "spending"],
    ["What did I spend at Swiggy this month", "spending"],
    ["spending in september", "spending"],
    ["how much can I spend?", "safe"],
    ["can I afford $20?", "safe"],
    ["what bills are due this week", "bills"],
    ["when is rent due?", "bills"],
    ["what subscriptions do I have", "subscriptions"],
    ["stop my Netflix subscription", "subscriptions"],
    ["lock in rent for next year", "bills"],
    // reminders: before payments, so "remind me to pay rent" never makes a payment card
    ["remind me to pay rent on the 1st", "remind"],
    ["remind me about netflix tomorrow at 9am", "remind"],
    ["what reminders do I have?", "reminders"],
    ["cancel my rent reminder", "reminder_cancel"],
    // goals
    ["save $500 for a trip by December", "goal_set", { name: "trip", question: false }],
    ["I want to save 50000 for a laptop by March. can I?", "goal_set", { name: "laptop", question: true }],
    ["how are my goals doing?", "goal_progress"],
    ["how much have I saved for the laptop", "goal_progress"],
    // control
    ["freeze everything", "freeze"],
    ["freeze claude", "freeze"],
    ["stop all agents", "freeze"],
    ["panic", "freeze"],
    ["unfreeze claude", "unfreeze"],
    ["did my payment go through?", "status"],
    ["what happened to the blue tokai payment", "status"],
    ["cancel that", "cancel"],
    ["Don't pay Blue Tokai $4, I already paid them in cash", "dont_pay"],
    // the rest
    ["hi", "greeting"],
    ["help", "help"],
    ["what's the weather in Paris", "unknown"],
  ];
  for (const [text, kind, fields] of cases) {
    it(`${kind}: ${text}`, () => {
      const intent = classify(text);
      expect(intent.kind).toBe(kind);
      if (fields) expect(intent).toMatchObject(fields);
    });
  }

  it("a correction in the same message pays the corrected amount, never the first", () => {
    const i = classify("pay blue tokai $50 for beans... no wait, make it $6");
    expect(i).toMatchObject({ kind: "pay", amount: { major: 6, cur: "USD" }, reason: "beans", corrected: { from: { major: 50 } } });
  });

  it("a bare corrected number keeps the currency of the first", () => {
    expect(classify("pay blue tokai $50 no wait 6")).toMatchObject({ amount: { major: 6, cur: "USD" }, direct: true });
  });

  it("stop or lock without agents or payments never freezes", () => {
    for (const t of ["stop my Netflix subscription", "lock in rent", "stop the music", "pause spotify"]) expect(classify(t).kind).not.toBe("freeze");
  });

  it("hedges and yes are told apart", () => {
    expect(isHedge("ok but wait")).toBe(true);
    expect(isYes("ok but wait")).toBe(false);
    expect(isYes("hmm ok")).toBe(false);
    expect(isYes("go ahead")).toBe(true);
  });
});

describe("amounts", () => {
  it("reads currencies, thousands and Indian grouping", () => {
    expect(amounts("pay $4.50").map((a) => [a.major, a.cur])).toEqual([[4.5, "USD"]]);
    expect(amounts("send ₹1,00,000 to papa").map((a) => [a.major, a.cur])).toEqual([[100000, "LOCAL"]]);
    expect(amounts("pay rs 500").map((a) => [a.major, a.cur])).toEqual([[500, "LOCAL"]]);
    expect(amounts("send 20 dollars").map((a) => [a.major, a.cur])).toEqual([[20, "USD"]]);
    expect(amounts("save 50k for a laptop").map((a) => a.major)).toEqual([50000]);
  });
  it("dates, times, counts and years are not amounts", () => {
    expect(amounts("remind me on the 1st at 6pm")).toEqual([]);
    expect(amounts("in 3 days")).toEqual([]);
    expect(amounts("on nov 5")).toEqual([]);
    expect(amounts("by december 2026")).toEqual([]);
    expect(pickAmount(amounts("2 coffees at $4 each"))).toMatchObject({ major: 4, cur: "USD" });
  });
  it("splits a correction after the first amount", () => {
    expect(splitCorrection("pay alex $50 no wait $6")).toEqual({ before: "pay alex $50", after: " no wait $6" });
    expect(splitCorrection("pay alex $50 for lunch")).toBeNull();
    expect(reasonOf("pay blue tokai $50 for coffee beans")).toBe("coffee beans");
  });
});

describe("contacts and categories", () => {
  const contacts = [{ name: "Alex Chen" }, { name: "Alex Rivera" }, { name: "Blue Tokai" }, { name: "Exa" }];
  it("an ambiguous first name matches every Alex; a full name matches one", () => {
    expect(matchContacts("send alex 10", contacts).map((c) => c.name)).toEqual(["Alex Chen", "Alex Rivera"]);
    expect(matchContacts("pay alex rivera $5", contacts).map((c) => c.name)).toEqual(["Alex Rivera"]);
    expect(matchContacts("pay blue tokai $4", contacts).map((c) => c.name)).toEqual(["Blue Tokai"]);
    expect(matchContacts("pay bob $5", contacts)).toEqual([]);
  });
  it("finds the ledger's category from everyday words", () => {
    const cats = ["Food", "Groceries", "Travel", "Bills"];
    expect(matchCategory("how much did I spend on food last month", cats)).toBe("Food");
    expect(matchCategory("eating out this month", cats)).toBe("Food");
    expect(matchCategory("cabs in september", cats)).toBe("Travel");
    expect(matchCategory("how much did I spend last month", cats)).toBeNull();
  });
  it("last month is the whole previous calendar month", () => {
    const now = new Date(2026, 9, 16, 12).getTime();
    const p = parsePeriod("food last month", now);
    expect([p.from, p.to]).toEqual([new Date(2026, 8, 1).getTime(), new Date(2026, 9, 1).getTime()]);
    expect(p.label).toBe("last month (September)");
    expect(parsePeriod("in august", now).from).toBe(new Date(2026, 7, 1).getTime());
    expect(parsePeriod("anything", now).from).toBe(new Date(2026, 9, 1).getTime());
  });
});

describe("reminder times in the owner's zone", () => {
  const tz = "Asia/Kolkata";
  // Fri 16 Oct 2026, 11:30 in Bengaluru.
  const now = Date.UTC(2026, 9, 16, 6, 0);
  const at = (ms: number | null) => (ms === null ? null : (({ year, month, day, hour, minute }) => `${year}-${month + 1}-${day} ${hour}:${String(minute).padStart(2, "0")}`)(local(ms, tz)));

  it("reads the usual ways people say when", () => {
    expect(at(parseWhen("remind me to pay rent on the 1st", now, tz))).toBe("2026-11-1 9:00");
    expect(at(parseWhen("tomorrow at 6pm", now, tz))).toBe("2026-10-17 18:00");
    expect(at(parseWhen("in 3 days", now, tz))).toBe("2026-10-19 9:00");
    expect(at(parseWhen("on friday", now, tz))).toBe("2026-10-23 9:00");
    expect(at(parseWhen("on 5 nov at 8:30am", now, tz))).toBe("2026-11-5 8:30");
    expect(at(parseWhen("on the 20th", now, tz))).toBe("2026-10-20 9:00");
    expect(parseWhen("pay rent", now, tz)).toBeNull();
  });
  it("monthly reminders move to the same day next month", () => {
    const first = parseWhen("on the 31st", now, tz)!;
    expect(at(first)).toBe("2026-10-31 9:00");
    expect(at(nextRepeat(first, "monthly", tz))).toBe("2026-11-30 9:00");
  });
  it("goal deadlines are the end of the named month", () => {
    expect(at(parseDeadline("save $500 for a trip by December", now, tz))).toBe("2026-12-31 23:59");
    expect(at(parseDeadline("by march", now, tz))).toBe("2027-3-31 23:59");
  });
  it("says when in calendar days", () => {
    expect(whenWords(now + 13 * 3_600_000, now, tz)).toBe("tomorrow");
    expect(daysUntil(Date.UTC(2026, 9, 18, 20), now, tz)).toBe(3);
  });
  it("pulls what to be reminded of out of the sentence", () => {
    expect(reminderWhat("remind me to pay rent on the 1st")).toBe("Pay rent");
    expect(reminderWhat("Remind me about the electricity bill tomorrow at 9")).toBe("The electricity bill");
  });
});

describe("quiet hours", () => {
  const tz = "Asia/Kolkata";
  const ist = (h: number, m = 0) => Date.UTC(2026, 9, 16, h, m) - 5.5 * 3_600_000;
  it("a window across midnight covers late night and early morning", () => {
    expect(inQuietHours(ist(23), tz, "22:00", "07:00")).toBe(true);
    expect(inQuietHours(ist(3), tz, "22:00", "07:00")).toBe(true);
    expect(inQuietHours(ist(7), tz, "22:00", "07:00")).toBe(false);
    expect(inQuietHours(ist(12), tz, "22:00", "07:00")).toBe(false);
    expect(inQuietHours(ist(21, 59), tz, "22:00", "07:00")).toBe(false);
  });
  it("a daytime window, an empty one, and a bad one", () => {
    expect(inQuietHours(ist(13, 30), tz, "13:00", "14:00")).toBe(true);
    expect(inQuietHours(ist(14), tz, "13:00", "14:00")).toBe(false);
    expect(inQuietHours(ist(13), tz, "08:00", "08:00")).toBe(false);
    expect(inQuietHours(ist(13), tz, "nonsense", "08:00")).toBe(false);
  });
  it("uses the owner's zone, not the server's", () => {
    // 23:00 in Bengaluru is 17:30 UTC and 13:30 in New York.
    expect(inQuietHours(ist(23), "America/New_York", "22:00", "07:00")).toBe(false);
  });
  it("finds the end of the quiet hours", () => {
    expect(at(afterQuietHours(ist(23), tz, "22:00", "07:00"))).toBe("2026-10-17 7:00");
    function at(ms: number) {
      const l = local(ms, tz);
      return `${l.year}-${l.month + 1}-${l.day} ${l.hour}:${String(l.minute).padStart(2, "0")}`;
    }
  });
});
