import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.daily("exchange rates and prices", { hourUTC: 2, minuteUTC: 15 }, internal.rates.refresh, {});

crons.daily("reset agent daily spend", { hourUTC: 18, minuteUTC: 30 }, internal.agents.resetDaily, {});

crons.interval("expire unanswered approvals", { minutes: 5 }, internal.tasks.expireStale, {});

crons.interval("delete idle demo sandboxes", { hours: 1 }, internal.demo.sweep, {});

// Bill, renewal, goal and chat reminders, in the app and on Telegram, outside each owner's quiet hours (#12).
crons.interval("send reminders", { minutes: 15 }, internal.reminders.run, {});

crons.interval("relayer test-ETH runway", { minutes: 15 }, internal.chain.checkRunway, {});

// AP2 human-not-present purchases: check each price watch and buy when the price is right.
crons.interval("price watches", { minutes: 1 }, internal.commerce.sweepWatches, {});

export default crons;
