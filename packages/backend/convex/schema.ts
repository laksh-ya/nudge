import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const currency = v.union(
  v.literal("INR"),
  v.literal("CNY"),
  v.literal("USD"),
  v.literal("USDC"),
  v.literal("EUR"),
  v.literal("GBP"),
);

export const paymentState = v.union(
  v.literal("drafted"),
  v.literal("needs_info"),
  v.literal("checked"),
  v.literal("awaiting_approval"),
  v.literal("reserved"),
  v.literal("submitted"),
  v.literal("confirmed"),
  v.literal("failed"),
  v.literal("cancelled"),
  v.literal("expired"),
  v.literal("unknown"),
);

export const channel = v.union(
  v.literal("app"),
  v.literal("telegram"),
  v.literal("whatsapp"),
  v.literal("mcp"),
  v.literal("family"),
);

// All money fields are integers in the currency's minor unit.
export default defineSchema({
  users: defineTable({
    tokenIdentifier: v.string(),
    name: v.string(),
    email: v.optional(v.string()),
    country: v.string(),
    currency,
    monthlyBudgetMinor: v.number(),
    emergencyMinor: v.number(),
    nextIncomeAt: v.number(),
  }).index("by_token", ["tokenIdentifier"]),

  accounts: defineTable({
    userId: v.id("users"),
    kind: v.union(
      v.literal("bank"),
      v.literal("card"),
      v.literal("upi"),
      v.literal("wallet"),
      v.literal("manual"),
    ),
    name: v.string(),
    institution: v.string(),
    last4: v.optional(v.string()),
    currency,
    balanceMinor: v.number(),
    syncedAt: v.number(),
    source: v.union(v.literal("statement"), v.literal("connected"), v.literal("manual")),
    can: v.array(v.union(v.literal("read"), v.literal("handoff"), v.literal("execute"))),
  }).index("by_user", ["userId"]),

  transactions: defineTable({
    userId: v.id("users"),
    accountId: v.id("accounts"),
    at: v.number(),
    amountMinor: v.number(),
    currency,
    merchant: v.string(),
    category: v.string(),
    status: v.union(v.literal("pending"), v.literal("posted")),
    kind: v.union(
      v.literal("spend"),
      v.literal("income"),
      v.literal("transfer"),
      v.literal("refund"),
    ),
  })
    .index("by_user_at", ["userId", "at"])
    .index("by_user_category_at", ["userId", "category", "at"]),

  obligations: defineTable({
    userId: v.id("users"),
    name: v.string(),
    kind: v.union(v.literal("bill"), v.literal("subscription")),
    amountMinor: v.number(),
    previousAmountMinor: v.optional(v.number()),
    currency,
    cadence: v.union(v.literal("weekly"), v.literal("monthly"), v.literal("yearly")),
    nextDueAt: v.number(),
    status: v.union(v.literal("active"), v.literal("paused"), v.literal("cancelled")),
    autopayLimitMinor: v.optional(v.number()),
    payeeId: v.optional(v.id("payees")),
  }).index("by_user_due", ["userId", "nextDueAt"]),

  goals: defineTable({
    userId: v.id("users"),
    name: v.string(),
    icon: v.string(),
    targetMinor: v.number(),
    savedMinor: v.number(),
    currency,
    dueAt: v.optional(v.number()),
  }).index("by_user", ["userId"]),

  wallets: defineTable({
    userId: v.id("users"),
    address: v.string(),
    chain: v.literal("base-sepolia"),
    asset: v.literal("USDC"),
    balanceMinor: v.number(),
    protectedMinor: v.number(),
    dailyCeilingMinor: v.number(),
    frozen: v.boolean(),
  }).index("by_user", ["userId"]),

  payees: defineTable({
    userId: v.id("users"),
    name: v.string(),
    handle: v.string(),
    kind: v.union(v.literal("person"), v.literal("merchant")),
    trusted: v.boolean(),
    holdUntil: v.optional(v.number()),
  }).index("by_user", ["userId"]),

  agents: defineTable({
    userId: v.id("users"),
    name: v.string(),
    provider: v.union(
      v.literal("own"),
      v.literal("claude"),
      v.literal("chatgpt"),
      v.literal("openclaw"),
      v.literal("hermes"),
      v.literal("poke"),
    ),
    status: v.union(v.literal("active"), v.literal("frozen"), v.literal("revoked")),
    scopes: v.array(
      v.union(v.literal("read"), v.literal("prepare"), v.literal("spend"), v.literal("request")),
    ),
    dailyCapMinor: v.number(),
    perPaymentMinor: v.number(),
    spentTodayMinor: v.number(),
    hidesBalances: v.boolean(),
    connectedAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    expiresAt: v.number(),
  }).index("by_user", ["userId"]),

  tasks: defineTable({
    userId: v.id("users"),
    title: v.string(),
    channel,
    agentId: v.optional(v.id("agents")),
    payeeId: v.optional(v.id("payees")),
    amountMinor: v.optional(v.number()),
    currency: v.optional(currency),
    purpose: v.optional(v.string()),
    state: paymentState,
    reason: v.optional(v.string()),
    rail: v.union(v.literal("simulator"), v.literal("base-sepolia"), v.literal("handoff")),
    txHash: v.optional(v.string()),
    approvalToken: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_user_updated", ["userId", "updatedAt"])
    .index("by_user_state", ["userId", "state"])
    .index("by_approval_token", ["approvalToken"]),

  messages: defineTable({
    userId: v.id("users"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    text: v.string(),
    channel,
    taskId: v.optional(v.id("tasks")),
  }).index("by_user", ["userId"]),

  family: defineTable({
    userId: v.id("users"),
    name: v.string(),
    relation: v.string(),
    country: v.string(),
    currency,
    status: v.union(v.literal("paired"), v.literal("invited")),
    monthlyAllowanceMinor: v.optional(v.number()),
  }).index("by_user", ["userId"]),

  familyRequests: defineTable({
    userId: v.id("users"),
    memberId: v.id("family"),
    direction: v.union(v.literal("incoming"), v.literal("outgoing")),
    note: v.string(),
    sendMinor: v.number(),
    sendCurrency: currency,
    receiveMinor: v.number(),
    receiveCurrency: currency,
    feeMinor: v.number(),
    quoteExpiresAt: v.number(),
    state: v.union(
      v.literal("requested"),
      v.literal("approved"),
      v.literal("sent"),
      v.literal("received"),
      v.literal("declined"),
    ),
  }).index("by_user", ["userId"]),

  activity: defineTable({
    userId: v.id("users"),
    kind: v.union(
      v.literal("payment"),
      v.literal("security"),
      v.literal("agent"),
      v.literal("import"),
      v.literal("setting"),
    ),
    title: v.string(),
    detail: v.optional(v.string()),
    tone: v.union(v.literal("neutral"), v.literal("good"), v.literal("warn"), v.literal("bad")),
  }).index("by_user", ["userId"]),
});
