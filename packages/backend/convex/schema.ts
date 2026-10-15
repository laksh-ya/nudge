import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const currency = v.union(
  v.literal("INR"),
  v.literal("CNY"),
  v.literal("USD"),
  v.literal("USDC"),
  v.literal("EUR"),
  v.literal("GBP"),
  v.literal("SGD"),
  v.literal("AED"),
  v.literal("JPY"),
  v.literal("HKD"),
  v.literal("AUD"),
  v.literal("CAD"),
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

export const sourceKind = v.union(
  v.literal("bank"),
  v.literal("card"),
  v.literal("payment_app"),
  v.literal("crypto"),
  v.literal("transfer"),
  v.literal("cash"),
);

export const capability = v.union(v.literal("read"), v.literal("prepare"), v.literal("handoff"), v.literal("execute"));

export const importKind = v.union(
  v.literal("csv"),
  v.literal("xlsx"),
  v.literal("pdf"),
  v.literal("scan"),
  v.literal("sandbox"),
  v.literal("manual"),
);

// All money fields are integers in the currency's minor unit.
export default defineSchema({
  users: defineTable({
    tokenIdentifier: v.string(),
    name: v.string(),
    email: v.optional(v.string()),
    /** ISO country code. */
    country: v.string(),
    /** Reporting currency. */
    currency,
    timezone: v.optional(v.string()),
    monthlyBudgetMinor: v.number(),
    emergencyMinor: v.number(),
    nextIncomeAt: v.number(),
    incomeDay: v.optional(v.number()),
    priorities: v.optional(v.array(v.string())),
    autonomy: v.optional(v.union(v.literal("draft"), v.literal("approve"), v.literal("limited"))),
    reminderChannel: v.optional(v.union(v.literal("app"), v.literal("telegram"), v.literal("whatsapp"))),
    quietFrom: v.optional(v.string()),
    quietTo: v.optional(v.string()),
    reminderLeadDays: v.optional(v.number()),
    onboardingStep: v.optional(v.string()),
    onboardedAt: v.optional(v.number()),
  }).index("by_token", ["tokenIdentifier"]),

  accounts: defineTable({
    userId: v.id("users"),
    kind: sourceKind,
    name: v.string(),
    institution: v.string(),
    providerId: v.optional(v.string()),
    country: v.optional(v.string()),
    last4: v.optional(v.string()),
    network: v.optional(v.string()),
    expiry: v.optional(v.string()),
    currency,
    balanceMinor: v.number(),
    syncedAt: v.number(),
    source: v.union(v.literal("sandbox"), v.literal("statement"), v.literal("onchain"), v.literal("manual")),
    can: v.array(capability),
    uses: v.optional(v.array(v.string())),
    status: v.optional(v.union(v.literal("ok"), v.literal("syncing"), v.literal("empty"), v.literal("error"))),
    statusNote: v.optional(v.string()),
    chain: v.optional(v.union(v.literal("evm"), v.literal("bitcoin"), v.literal("solana"))),
    address: v.optional(v.string()),
    verified: v.optional(v.boolean()),
  }).index("by_user", ["userId"]),

  holdings: defineTable({
    userId: v.id("users"),
    accountId: v.id("accounts"),
    chain: v.string(),
    asset: v.string(),
    amount: v.number(),
    usdMinor: v.number(),
    updatedAt: v.number(),
  }).index("by_account", ["accountId"]),

  transactions: defineTable({
    userId: v.id("users"),
    accountId: v.id("accounts"),
    at: v.number(),
    amountMinor: v.number(),
    currency,
    merchant: v.string(),
    category: v.string(),
    status: v.union(v.literal("pending"), v.literal("posted")),
    kind: v.union(v.literal("spend"), v.literal("income"), v.literal("transfer"), v.literal("refund")),
    importId: v.optional(v.id("imports")),
    fingerprint: v.optional(v.string()),
    duplicateOf: v.optional(v.id("transactions")),
    pairId: v.optional(v.string()),
    note: v.optional(v.string()),
    categoryLocked: v.optional(v.boolean()),
    receiptId: v.optional(v.id("_storage")),
    raw: v.optional(v.string()),
  })
    .index("by_user_at", ["userId", "at"])
    .index("by_user_category_at", ["userId", "category", "at"])
    .index("by_account_at", ["accountId", "at"]),

  imports: defineTable({
    userId: v.id("users"),
    accountId: v.id("accounts"),
    kind: importKind,
    fileName: v.optional(v.string()),
    fileId: v.optional(v.id("_storage")),
    rows: v.number(),
    added: v.number(),
    duplicates: v.number(),
    transfers: v.number(),
    fromAt: v.optional(v.number()),
    toAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_account", ["accountId"]),

  rules: defineTable({
    userId: v.id("users"),
    key: v.string(),
    category: v.string(),
  }).index("by_user_key", ["userId", "key"]),

  obligations: defineTable({
    userId: v.id("users"),
    name: v.string(),
    kind: v.union(v.literal("bill"), v.literal("subscription")),
    amountMinor: v.number(),
    previousAmountMinor: v.optional(v.number()),
    currency,
    cadence: v.union(v.literal("weekly"), v.literal("monthly"), v.literal("yearly")),
    nextDueAt: v.number(),
    status: v.union(
      v.literal("active"),
      v.literal("paused"),
      v.literal("cancelled"),
      v.literal("suggested"),
      v.literal("dismissed"),
    ),
    autopayLimitMinor: v.optional(v.number()),
    payeeId: v.optional(v.id("payees")),
    merchantKey: v.optional(v.string()),
    source: v.optional(v.union(v.literal("detected"), v.literal("manual"))),
    occurrences: v.optional(v.number()),
    lastPaidAt: v.optional(v.number()),
    accountId: v.optional(v.id("accounts")),
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
    /** Empty until the vault contract is deployed for this user. */
    address: v.string(),
    chain: v.literal("base-sepolia"),
    asset: v.literal("USDC"),
    balanceMinor: v.number(),
    protectedMinor: v.number(),
    dailyCeilingMinor: v.number(),
    perPaymentMinor: v.optional(v.number()),
    frozen: v.boolean(),
    // On-chain vault. Absent status means the wallet runs on the simulator.
    status: v.optional(v.union(v.literal("enrolling"), v.literal("deploying"), v.literal("live"), v.literal("error"))),
    statusNote: v.optional(v.string()),
    enrolToken: v.optional(v.string()),
    enrolExpiresAt: v.optional(v.number()),
    keyX: v.optional(v.string()),
    keyY: v.optional(v.string()),
    keyId: v.optional(v.string()),
    credentialId: v.optional(v.string()),
    rpId: v.optional(v.string()),
    tokenAddress: v.optional(v.string()),
    deployTx: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_enrol_token", ["enrolToken"]),

  payees: defineTable({
    userId: v.id("users"),
    name: v.string(),
    handle: v.string(),
    kind: v.union(v.literal("person"), v.literal("merchant")),
    trusted: v.boolean(),
    holdUntil: v.optional(v.number()),
    address: v.optional(v.string()),
    onchain: v.optional(v.boolean()),
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
    status: v.union(v.literal("active"), v.literal("frozen"), v.literal("revoked"), v.literal("pending")),
    scopes: v.array(v.union(v.literal("read"), v.literal("prepare"), v.literal("spend"), v.literal("request"))),
    dailyCapMinor: v.number(),
    perPaymentMinor: v.number(),
    spentTodayMinor: v.number(),
    hidesBalances: v.boolean(),
    connectedAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    expiresAt: v.number(),
    tokenHash: v.optional(v.string()),
    chainAddress: v.optional(v.string()),
    onchain: v.optional(v.boolean()),
  })
    .index("by_user", ["userId"])
    .index("by_token_hash", ["tokenHash"]),

  /** Agent signing keys for the executor. Never returned by any public function. */
  agentKeys: defineTable({
    agentId: v.id("agents"),
    address: v.string(),
    privateKey: v.string(),
  }).index("by_agent", ["agentId"]),

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
    refusalCode: v.optional(v.number()),
    /** The exact vault action the owner signs, when this task runs on-chain. */
    action: v.optional(v.object({ op: v.number(), data: v.string(), nonce: v.string(), deadline: v.number() })),
    effects: v.optional(v.object({ agents: v.array(v.id("agents")), payees: v.array(v.id("payees")) })),
    approvalToken: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_user_updated", ["userId", "updatedAt"])
    .index("by_user_state", ["userId", "state"])
    .index("by_approval_token", ["approvalToken"])
    .index("by_state_expires", ["state", "expiresAt"]),

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

  rates: defineTable({
    date: v.string(),
    /** Units of each fiat currency per 1 USD. */
    fiat: v.record(v.string(), v.number()),
    /** USD price per coin, keyed by CoinGecko id. */
    crypto: v.record(v.string(), v.number()),
    fetchedAt: v.number(),
  }).index("by_fetched", ["fetchedAt"]),

  chatLinks: defineTable({
    userId: v.id("users"),
    channel: v.union(v.literal("telegram"), v.literal("whatsapp")),
    code: v.string(),
    externalId: v.optional(v.string()),
    linkedAt: v.optional(v.number()),
  })
    .index("by_code", ["code"])
    .index("by_user", ["userId"])
    .index("by_external", ["channel", "externalId"]),
});
