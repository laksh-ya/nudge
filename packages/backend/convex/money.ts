import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query } from "./_generated/server";
import { viewer } from "./lib/auth";

export const accounts = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return [];
    return await ctx.db.query("accounts").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50);
  },
});

export const transactions = query({
  args: { paginationOpts: paginationOptsValidator, category: v.optional(v.string()) },
  handler: async (ctx, { paginationOpts, category }) => {
    const user = await viewer(ctx);
    if (!user) return { page: [], isDone: true, continueCursor: "" };
    const q = category
      ? ctx.db
          .query("transactions")
          .withIndex("by_user_category_at", (q) => q.eq("userId", user._id).eq("category", category))
      : ctx.db.query("transactions").withIndex("by_user_at", (q) => q.eq("userId", user._id));
    return await q.order("desc").paginate(paginationOpts);
  },
});

export const obligations = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return [];
    return await ctx.db
      .query("obligations")
      .withIndex("by_user_due", (q) => q.eq("userId", user._id))
      .take(100);
  },
});

export const goals = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return [];
    return await ctx.db.query("goals").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50);
  },
});
