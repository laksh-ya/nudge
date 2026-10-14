import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.daily("exchange rates and prices", { hourUTC: 2, minuteUTC: 15 }, internal.rates.refresh, {});

crons.daily("reset agent daily spend", { hourUTC: 18, minuteUTC: 30 }, internal.agents.resetDaily, {});

export default crons;
