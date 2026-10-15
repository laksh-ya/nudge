import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.daily("exchange rates and prices", { hourUTC: 2, minuteUTC: 15 }, internal.rates.refresh, {});

crons.daily("reset agent daily spend", { hourUTC: 18, minuteUTC: 30 }, internal.agents.resetDaily, {});

crons.interval("expire unanswered approvals", { minutes: 5 }, internal.tasks.expireStale, {});

crons.interval("delete idle demo sandboxes", { hours: 1 }, internal.demo.sweep, {});

export default crons;
