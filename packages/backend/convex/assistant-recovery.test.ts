/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { ungroundedNumbers } from "./lib/grounding";
import { local, nextRepeat, parseWhen } from "./lib/schedule";

vi.mock("./lib/relayer", () => {
  const pool = { enqueueAction: vi.fn(async () => "queued") };
  return { relayer: pool, agentPool: pool, lanePool: () => pool, laneOf: () => 0, laneCount: () => 1, MAX_LANES: 4 };
});
const modules = import.meta.glob(["./**/*.ts", "./**/*.js", "!./**/*.test.ts"]);
const NOW = Date.UTC(2026, 9, 17, 6);
const DAY = 86400000;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function fixture() {
  const t = convexTest(schema, modules);
  const o = t.withIdentity({ subject: "alice", issuer: "https://test.local", tokenIdentifier: "https://test.local|alice" });
  const userId = (await o.mutation(api.users.ensure, {}))!;
  const payeeId = await t.run(async (ctx) => {
    await ctx.db.patch(userId, { timezone: "Asia/Kolkata", reminderChannel: "telegram", privateReminders: true });
    await ctx.db.insert("chatLinks", { userId, channel: "telegram", code: "used-x", externalId: "123", linkedAt: NOW });
    return await ctx.db.insert("payees", { userId, name: "Blue Tokai", handle: "shop", kind: "merchant", trusted: true });
  });
  const say = async (text: string) => {
    vi.advanceTimersByTime(1);
    await t.mutation(internal.messages.reply, { userId, text });
    return await t.run(async (ctx) => (await ctx.db.query("messages").withIndex("by_user", (q) => q.eq("userId", userId)).order("desc").first())!);
  };
  return { t, o, userId, payeeId, say };
}

describe("recovered conversation lifecycle", () => {
  it("revokes the previous approval before asking which corrected payee", async () => {
    const f = await fixture();
    const first = await f.say("Pay Blue Tokai $50");
    await f.t.run(async (ctx) => {
      for (const name of ["Alex Chen", "Alex Rivera"]) await ctx.db.insert("payees", { userId: f.userId, name, handle: name, kind: "person", trusted: true });
    });
    const correction = await f.say("I meant Alex");
    expect(correction.text).toMatch(/Which/);
    const old = await f.t.run((ctx) => ctx.db.get(first.taskId!));
    expect(old).toMatchObject({ state: "cancelled" });
    expect(old!.approvalToken).toBeUndefined();
    const next = await f.say("Alex Chen");
    expect(next.text).toMatch(/Alex Chen/);
    const tasks = await f.t.run((ctx) => ctx.db.query("tasks").collect());
    expect(tasks.filter((t) => t.state === "awaiting_approval")).toHaveLength(1);
  });
  it("replaces a payment amount and only leaves the new approval active", async () => {
    const f = await fixture();
    const old = await f.say("Pay Blue Tokai $50");
    const next = await f.say("no wait, make it $5");
    expect((await f.t.run((ctx) => ctx.db.get(old.taskId!)))!.state).toBe("cancelled");
    expect((await f.t.run((ctx) => ctx.db.get(next.taskId!)))!.amountMinor).toBe(500);
  });
  it("an unrelated numeric question cannot answer a pending amount", async () => {
    const f = await fixture();
    await f.say("Pay Blue Tokai");
    await f.say("Can I afford $20?");
    expect(await f.t.run((ctx) => ctx.db.query("tasks").collect())).toHaveLength(0);
  });
  it("hedging keeps a request unpaid, and a chat yes never approves it", async () => {
    const f = await fixture();
    const old = await f.say("Pay Blue Tokai $50");
    await f.say("ok but wait");
    await f.say("yes");
    expect((await f.t.run((ctx) => ctx.db.get(old.taskId!)))!.state).toBe("awaiting_approval");
    expect(await f.t.run((ctx) => ctx.db.query("tasks").collect())).toHaveLength(1);
  });
  it("an unknown currency and ambiguous first name require separate clarification", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      for (const name of ["Alex Chen", "Alex Rivera"]) await ctx.db.insert("payees", { userId: f.userId, name, handle: name, kind: "person", trusted: true });
    });
    expect((await f.say("send Alex 5")).text).toMatch(/Which/);
    expect((await f.say("Alex Chen")).text).toMatch(/test dollars/);
    expect(await f.t.run((ctx) => ctx.db.query("tasks").collect())).toHaveLength(0);
  });
  it("negative or quoted amounts cannot execute directly", async () => {
    const f = await fixture();
    for (const text of ["Pay Blue Tokai -$5", 'Pay Blue Tokai "$5"', "pay Blue Tokai $5 but wait"]) {
      const reply = await f.say(text);
      const task = reply.taskId ? await f.t.run((ctx) => ctx.db.get(reply.taskId!)) : null;
      expect(task?.state).not.toBe("submitted");
    }
  });
  it("model-key mode uses the same deterministic correction and never calls a model", async () => {
    const f = await fixture();
    vi.stubEnv("ANTHROPIC_API_KEY", "not-a-real-key");
    await f.t.action(internal.assistant.respond, { userId: f.userId, text: "Pay Blue Tokai $50" });
    await f.t.action(internal.assistant.respond, { userId: f.userId, text: "actually $5" });
    const tasks = await f.t.run((ctx) => ctx.db.query("tasks").collect());
    expect(tasks.map((t) => [t.amountMinor, t.state])).toEqual([[5000, "cancelled"], [500, "awaiting_approval"]]);
  });
});

describe("reminders with transactional delivery records", () => {
  it("bill-cycle cron retries cannot create duplicate in-app or Telegram reminders", async () => {
    const f = await fixture();
    await f.t.run((ctx) => ctx.db.insert("obligations", { userId: f.userId, name: "Rent", kind: "bill", currency: "INR", amountMinor: 2000000, cadence: "monthly", nextDueAt: NOW + DAY, status: "active" }));
    await f.t.mutation(internal.reminders.run, {});
    await f.t.mutation(internal.reminders.run, {});
    const rows = await f.t.run((ctx) => ctx.db.query("messages").collect());
    expect(rows.filter((m) => m.reminder)).toHaveLength(1);
    expect(await f.t.run((ctx) => ctx.db.query("reminderDeliveries").collect())).toHaveLength(1);
  });
  it("quiet hours defer without consuming the cycle, then deliver once", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.userId, { quietFrom: "10:00", quietTo: "12:00" });
      await ctx.db.insert("reminders", { userId: f.userId, text: "Pay rent", dueAt: NOW - 1000, status: "scheduled" });
    });
    expect(await f.t.mutation(internal.reminders.run, {})).toMatchObject({ sent: 0, deferred: 1 });
    vi.advanceTimersByTime(3600000);
    expect(await f.t.mutation(internal.reminders.run, {})).toMatchObject({ sent: 1 });
    expect(await f.t.mutation(internal.reminders.run, {})).toMatchObject({ sent: 0 });
  });
  it("privacy is re-read at dispatch and a delivery can only be claimed once", async () => {
    const f = await fixture();
    await f.o.mutation(api.reminders.sendTest, {});
    const row = await f.t.run(async (ctx) => (await ctx.db.query("reminderDeliveries").first())!);
    await f.t.run((ctx) => ctx.db.patch(row._id, { text: "Pay Alex $1234", privateText: "A bill is due. Open the app." }));
    const claimed = await f.t.mutation(internal.reminders.claimDelivery, { deliveryId: row._id });
    expect(claimed!.text).not.toMatch(/Alex|1234/);
    expect(await f.t.mutation(internal.reminders.claimDelivery, { deliveryId: row._id })).toBeNull();
  });
  it("explicit rate limits retry at most twice; ambiguous failures never retry", async () => {
    const f = await fixture();
    await f.o.mutation(api.reminders.sendTest, {});
    const row = await f.t.run(async (ctx) => (await ctx.db.query("reminderDeliveries").first())!);
    for (let attempt = 0; attempt < 3; attempt++) {
      await f.t.mutation(internal.reminders.claimDelivery, { deliveryId: row._id });
      await f.t.mutation(internal.reminders.finishDelivery, { deliveryId: row._id, ok: false, retryAfter: 60 });
      vi.advanceTimersByTime(61000);
    }
    expect(await f.t.run((ctx) => ctx.db.get(row._id))).toMatchObject({ status: "failed", attempts: 3 });
    await f.o.mutation(api.reminders.sendTest, {});
    const fresh = await f.t.run(async (ctx) => (await ctx.db.query("reminderDeliveries").order("desc").first())!);
    await f.t.mutation(internal.reminders.claimDelivery, { deliveryId: fresh._id });
    await f.t.mutation(internal.reminders.finishDelivery, { deliveryId: fresh._id, ok: false, unknown: true, error: "network timeout" });
    expect(await f.t.run((ctx) => ctx.db.get(fresh._id))).toMatchObject({ status: "unknown", attempts: 1 });
    expect(await f.t.mutation(internal.reminders.claimDelivery, { deliveryId: fresh._id })).toBeNull();
  });
  it("a reminder can only be cancelled by its owner", async () => {
    const f = await fixture();
    const id = await f.t.run((ctx) => ctx.db.insert("reminders", { userId: f.userId, text: "Rent", dueAt: NOW + DAY, status: "scheduled" }));
    const stranger = f.t.withIdentity({ subject: "eve", tokenIdentifier: "https://test.local|eve" });
    await stranger.mutation(api.users.ensure, {});
    await expect(stranger.mutation(api.reminders.cancel, { reminderId: id })).rejects.toThrow(/No such reminder/);
    await f.o.mutation(api.reminders.cancel, { reminderId: id });
    expect(await f.t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "cancelled" });
  });
  it("relative days cross month boundaries and recurring month-end retains its intended day", () => {
    const jan30 = Date.UTC(2027, 0, 30, 6);
    expect(local(parseWhen("in 3 days", jan30, "UTC")!, "UTC")).toMatchObject({ month: 1, day: 2 });
    const jan31 = Date.UTC(2027, 0, 31, 9);
    const feb = nextRepeat(jan31, "monthly", "UTC", 31);
    expect(local(feb, "UTC")).toMatchObject({ month: 1, day: 28 });
    expect(local(nextRepeat(feb, "monthly", "UTC", 31), "UTC")).toMatchObject({ month: 2, day: 31 });
  });
});

describe("model figures are grounded", () => {
  it.each(["$999", "$9.99", "₹500", "-50", "100%", "20 dollars", "paid 75", "3 payments", "€200", "10,000"])("rejects invented figure: %s", (reply) => {
    expect(ungroundedNumbers(reply, ['{"available":"$12.50","payments":2}', "show my balance"])).not.toHaveLength(0);
  });
  it("accepts recorded or owner-stated numbers with normal formatting", () => {
    expect(ungroundedNumbers("You asked for $1,200.00; the recorded balance is $12.50 across 2 payments.", ["pay $1200", '{"balance":"$12.50","payments":2}'])).toEqual([]);
  });
});
