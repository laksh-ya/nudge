import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.daily("exchange rates and prices", { hourUTC: 2, minuteUTC: 15 }, internal.rates.refresh, {});

export default crons;
