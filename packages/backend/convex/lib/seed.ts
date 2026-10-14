import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

const DAY = 86_400_000;
const HOUR = 3_600_000;

function token() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 24);
}

export function newApprovalToken() {
  return token();
}

/** Sample financial life for a new account so every screen has something real to show. */
export async function seedUser(ctx: MutationCtx, userId: Id<"users">) {
  const now = Date.now();
  const at = (days: number, hours = 0) => now - days * DAY - hours * HOUR;

  const hdfc = await ctx.db.insert("accounts", {
    userId,
    kind: "bank",
    name: "Savings",
    institution: "HDFC Bank",
    last4: "4821",
    currency: "INR",
    balanceMinor: 8_425_000,
    syncedAt: now - 2 * HOUR,
    source: "statement",
    can: ["read"],
    providerId: "bank:IN:hdfc-bank",
    country: "IN",
    status: "ok",
    uses: ["Everyday", "Bills"],
  });
  const card = await ctx.db.insert("accounts", {
    userId,
    kind: "card",
    name: "Amazon Pay Credit Card",
    institution: "ICICI Bank",
    last4: "1093",
    network: "Visa",
    expiry: "08/29",
    status: "ok",
    uses: ["Shopping"],
    currency: "INR",
    balanceMinor: -1_248_000,
    syncedAt: now - 5 * HOUR,
    source: "statement",
    can: ["read"],
  });
  const upi = await ctx.db.insert("accounts", {
    userId,
    kind: "payment_app",
    name: "UPI Lite",
    institution: "Paytm",
    providerId: "app:paytm",
    currency: "INR",
    balanceMinor: 214_000,
    syncedAt: now - DAY,
    source: "manual",
    can: ["read", "handoff"],
    status: "ok",
    uses: ["Everyday"],
  });
  const coinbase = await ctx.db.insert("accounts", {
    userId,
    kind: "crypto",
    name: "Coinbase",
    institution: "Coinbase",
    providerId: "exchange:coinbase",
    currency: "USD",
    balanceMinor: 41_250,
    syncedAt: now - 3 * DAY,
    source: "statement",
    can: ["read"],
    status: "ok",
    uses: ["Crypto"],
  });
  await ctx.db.insert("holdings", { userId, accountId: coinbase, chain: "bitcoin", asset: "BTC", amount: 0.003, usdMinor: 24_478, updatedAt: now - 3 * DAY });
  await ctx.db.insert("holdings", { userId, accountId: coinbase, chain: "ethereum", asset: "ETH", amount: 0.0691, usdMinor: 16_772, updatedAt: now - 3 * DAY });
  for (const [accountId, fileName, rows] of [
    [hdfc, "HDFC_Statement_Sep-Oct.csv", 214],
    [card, "ICICI_Card_Oct.pdf", 38],
  ] as const) {
    await ctx.db.insert("imports", { userId, accountId, kind: fileName.endsWith(".pdf") ? "pdf" : "csv", fileName, rows, added: rows, duplicates: 0, transfers: 2, fromAt: now - 45 * DAY, toAt: now - DAY });
  }

  const spends: Array<[number, number, string, string, Id<"accounts">, "pending" | "posted"]> = [
    [0, 2, "Swiggy", "Food", upi, "pending"],
    [0, 5, "Blinkit", "Groceries", card, "posted"],
    [1, 3, "Uber", "Travel", card, "posted"],
    [1, 9, "Third Wave Coffee", "Food", upi, "posted"],
    [2, 1, "Zomato", "Food", card, "posted"],
    [3, 4, "Amazon", "Shopping", card, "posted"],
    [4, 6, "BigBasket", "Groceries", hdfc, "posted"],
    [5, 2, "Namma Metro", "Travel", upi, "posted"],
    [6, 8, "PVR Cinemas", "Fun", card, "posted"],
    [8, 1, "Swiggy Instamart", "Groceries", upi, "posted"],
    [9, 3, "Uber", "Travel", card, "posted"],
    [11, 5, "Decathlon", "Shopping", card, "posted"],
    [12, 2, "Zomato", "Food", card, "posted"],
    [14, 7, "Apollo Pharmacy", "Health", hdfc, "posted"],
    [16, 2, "Blinkit", "Groceries", upi, "posted"],
    [19, 4, "IndiGo", "Travel", card, "posted"],
    [22, 6, "Swiggy", "Food", card, "posted"],
  ];
  const amounts = [
    38_900, 64_250, 31_200, 26_000, 52_800, 289_900, 186_400, 6_000, 84_000, 47_350, 27_800,
    349_900, 41_600, 23_450, 39_900, 689_500, 45_200,
  ];
  for (const [i, [d, h, merchant, category, accountId, status]] of spends.entries()) {
    await ctx.db.insert("transactions", {
      userId,
      accountId,
      at: at(d, h),
      amountMinor: -(amounts[i] ?? 10_000),
      currency: "INR",
      merchant,
      category,
      status,
      kind: "spend",
    });
  }
  const fixed: Array<[number, number, number, string, Id<"accounts">, "spend" | "income" | "transfer" | "refund"]> = [
    [2, 0, -1_800_000, "Ramesh Iyer", hdfc, "spend"],
    [3, 0, 9_500_000, "Acme Labs salary", hdfc, "income"],
    [3, 2, -64_900, "Netflix", card, "spend"],
    [7, 0, -11_900, "Spotify", card, "spend"],
    [10, 0, -2_000_000, "ICICI card repayment", hdfc, "transfer"],
    [13, 0, -184_000, "BESCOM", hdfc, "spend"],
    [15, 0, 289_900, "Amazon refund", card, "refund"],
    [18, 0, -59_900, "Airtel Postpaid", hdfc, "spend"],
    [20, 0, -1_540_000, "Ananya · allowance", hdfc, "transfer"],
  ];
  const fixedCategory: Record<string, string> = {
    "Ramesh Iyer": "Rent",
    "Acme Labs salary": "Income",
    Netflix: "Subscriptions",
    Spotify: "Subscriptions",
    "ICICI card repayment": "Transfer",
    BESCOM: "Bills",
    "Amazon refund": "Shopping",
    "Airtel Postpaid": "Bills",
    "Ananya · allowance": "Family",
  };
  for (const [d, h, amountMinor, merchant, accountId, kind] of fixed) {
    await ctx.db.insert("transactions", {
      userId,
      accountId,
      at: at(d, h),
      amountMinor,
      currency: "INR",
      merchant,
      category: fixedCategory[merchant] ?? "Other",
      status: "posted",
      kind,
    });
  }

  const landlord = await ctx.db.insert("payees", {
    userId,
    name: "Ramesh Iyer",
    handle: "ramesh.iyer@okhdfc",
    kind: "person",
    trusted: true,
  });
  const bescom = await ctx.db.insert("payees", {
    userId,
    name: "BESCOM",
    handle: "bescom@billdesk",
    kind: "merchant",
    trusted: true,
  });
  const exa = await ctx.db.insert("payees", {
    userId,
    name: "Exa",
    handle: "0x4b2e…91c0",
    kind: "merchant",
    trusted: true,
  });
  const blueTokai = await ctx.db.insert("payees", {
    userId,
    name: "Blue Tokai",
    handle: "0x77a1…3e08",
    kind: "merchant",
    trusted: true,
  });
  const ananya = await ctx.db.insert("payees", {
    userId,
    name: "Ananya Mehta",
    handle: "0x2c9d…a41f",
    kind: "person",
    trusted: true,
  });
  const namecheap = await ctx.db.insert("payees", {
    userId,
    name: "Namecheap",
    handle: "0x8d03…12bb",
    kind: "merchant",
    trusted: false,
    holdUntil: now + 20 * HOUR,
  });

  const bills: Array<{
    name: string;
    kind: "bill" | "subscription";
    amountMinor: number;
    previousAmountMinor?: number;
    cadence: "monthly" | "yearly";
    dueInDays: number;
    payeeId?: Id<"payees">;
    autopayLimitMinor?: number;
  }> = [
    { name: "BESCOM", kind: "bill", amountMinor: 184_000, cadence: "monthly", dueInDays: 2, payeeId: bescom },
    { name: "Rent", kind: "bill", amountMinor: 1_800_000, cadence: "monthly", dueInDays: 6, payeeId: landlord },
    { name: "Airtel Postpaid", kind: "bill", amountMinor: 69_900, previousAmountMinor: 59_900, cadence: "monthly", dueInDays: 9 },
    { name: "Netflix", kind: "subscription", amountMinor: 64_900, cadence: "monthly", dueInDays: 26, autopayLimitMinor: 70_000 },
    { name: "Spotify", kind: "subscription", amountMinor: 11_900, cadence: "monthly", dueInDays: 22, autopayLimitMinor: 15_000 },
    { name: "iCloud+", kind: "subscription", amountMinor: 7_500, cadence: "monthly", dueInDays: 12 },
    { name: "Cult.fit", kind: "subscription", amountMinor: 1_399_900, cadence: "yearly", dueInDays: 41 },
  ];
  for (const b of bills) {
    await ctx.db.insert("obligations", {
      userId,
      name: b.name,
      kind: b.kind,
      amountMinor: b.amountMinor,
      previousAmountMinor: b.previousAmountMinor,
      currency: "INR",
      cadence: b.cadence,
      nextDueAt: now + b.dueInDays * DAY,
      status: "active",
      autopayLimitMinor: b.autopayLimitMinor,
      payeeId: b.payeeId,
      source: "manual",
    });
  }
  await ctx.db.insert("obligations", {
    userId,
    name: "Google One",
    kind: "subscription",
    amountMinor: 13_000,
    currency: "INR",
    cadence: "monthly",
    nextDueAt: now + 17 * DAY,
    status: "suggested",
    merchantKey: "google one",
    source: "detected",
    occurrences: 3,
    lastPaidAt: now - 13 * DAY,
    accountId: card,
  });

  await ctx.db.insert("goals", { userId, name: "Goa in December", icon: "palmtree", targetMinor: 2_500_000, savedMinor: 950_000, currency: "INR", dueAt: now + 60 * DAY });
  await ctx.db.insert("goals", { userId, name: "New laptop", icon: "laptop", targetMinor: 9_000_000, savedMinor: 4_100_000, currency: "INR" });

  await ctx.db.insert("wallets", {
    userId,
    address: "",
    chain: "base-sepolia",
    asset: "USDC",
    balanceMinor: 25_000,
    protectedMinor: 5_000,
    dailyCeilingMinor: 4_000,
    frozen: false,
  });

  const own = await ctx.db.insert("agents", {
    userId,
    name: "Your assistant",
    provider: "own",
    status: "active",
    scopes: ["read", "prepare", "spend", "request"],
    dailyCapMinor: 2_500,
    perPaymentMinor: 1_500,
    spentTodayMinor: 840,
    hidesBalances: false,
    connectedAt: at(30),
    lastUsedAt: now - 40 * 60_000,
    expiresAt: now + 335 * DAY,
  });
  const claude = await ctx.db.insert("agents", {
    userId,
    name: "Claude",
    provider: "claude",
    status: "active",
    scopes: ["read", "prepare", "spend", "request"],
    dailyCapMinor: 1_500,
    perPaymentMinor: 1_000,
    spentTodayMinor: 0,
    hidesBalances: true,
    connectedAt: at(9),
    lastUsedAt: now - 12 * 60_000,
    expiresAt: now + 21 * DAY,
  });
  await ctx.db.insert("agents", {
    userId,
    name: "ChatGPT",
    provider: "chatgpt",
    status: "active",
    scopes: ["read", "prepare"],
    dailyCapMinor: 0,
    perPaymentMinor: 0,
    spentTodayMinor: 0,
    hidesBalances: true,
    connectedAt: at(4),
    lastUsedAt: at(1, 3),
    expiresAt: now + 26 * DAY,
  });
  const openclaw = await ctx.db.insert("agents", {
    userId,
    name: "OpenClaw",
    provider: "openclaw",
    status: "frozen",
    scopes: ["read", "prepare", "spend"],
    dailyCapMinor: 1_000,
    perPaymentMinor: 500,
    spentTodayMinor: 0,
    hidesBalances: true,
    connectedAt: at(6),
    lastUsedAt: at(0, 3),
    expiresAt: now + 8 * DAY,
  });

  const exaTask = await ctx.db.insert("tasks", {
    userId,
    title: "Exa search credits",
    channel: "mcp",
    agentId: claude,
    payeeId: exa,
    amountMinor: 1_800,
    currency: "USDC",
    purpose: "Research run for the Goa trip plan",
    state: "awaiting_approval",
    reason: "Above Claude's $10 per-payment limit",
    rail: "simulator",
    approvalToken: token(),
    expiresAt: now + 25 * 60_000,
    updatedAt: now - 12 * 60_000,
  });
  const billTask = await ctx.db.insert("tasks", {
    userId,
    title: "BESCOM electricity",
    channel: "telegram",
    agentId: own,
    payeeId: bescom,
    amountMinor: 184_000,
    currency: "INR",
    purpose: "October bill",
    state: "awaiting_approval",
    reason: "Bills from your bank need your approval",
    rail: "handoff",
    approvalToken: token(),
    expiresAt: now + 2 * DAY,
    updatedAt: now - 55 * 60_000,
  });
  await ctx.db.insert("tasks", {
    userId,
    title: "Domain renewal",
    channel: "mcp",
    agentId: claude,
    payeeId: namecheap,
    amountMinor: 1_120,
    currency: "USDC",
    state: "unknown",
    reason: "Network timed out after sending. Checking before any retry.",
    rail: "simulator",
    updatedAt: now - 2 * 60_000,
  });
  await ctx.db.insert("tasks", {
    userId,
    title: "Coffee beans",
    channel: "telegram",
    agentId: own,
    payeeId: blueTokai,
    amountMinor: 840,
    currency: "USDC",
    state: "confirmed",
    rail: "simulator",
    updatedAt: now - 40 * 60_000,
  });
  await ctx.db.insert("tasks", {
    userId,
    title: "Invoice from a forwarded message",
    channel: "mcp",
    agentId: openclaw,
    amountMinor: 4_900,
    currency: "USDC",
    state: "failed",
    reason: "Blocked. The payee isn't in your contacts, and the request came from a forwarded message.",
    rail: "simulator",
    updatedAt: now - 3 * HOUR,
  });
  await ctx.db.insert("tasks", {
    userId,
    title: "Allowance for Ananya",
    channel: "family",
    payeeId: ananya,
    amountMinor: 1_540_000,
    currency: "INR",
    state: "confirmed",
    rail: "simulator",
    updatedAt: at(20),
  });

  const thread: Array<["user" | "assistant", string, Id<"tasks"> | undefined]> = [
    ["user", "Pay the electricity bill", undefined],
    ["assistant", "BESCOM is ₹1,840, due in 2 days. It goes from your HDFC account, so approve it and I'll open UPI for you.", billTask],
    ["user", "How much can I spend this week?", undefined],
    ["assistant", "About ₹8,900 this week, or ₹1,270 a day until payday. That’s after rent, bills and your emergency fund.", undefined],
    ["assistant", "Claude asked to pay Exa $18.00. That's above its $10 limit, so it needs you.", exaTask],
  ];
  for (const [role, text, taskId] of thread) {
    await ctx.db.insert("messages", { userId, role, text, channel: "telegram", taskId });
  }

  const sister = await ctx.db.insert("family", {
    userId,
    name: "Ananya",
    relation: "Sister",
    country: "China",
    currency: "CNY",
    status: "paired",
    monthlyAllowanceMinor: 150_000,
  });
  await ctx.db.insert("family", { userId, name: "Papa", relation: "Father", country: "India", currency: "INR", status: "paired" });
  await ctx.db.insert("family", { userId, name: "Rohan", relation: "Cousin", country: "United Kingdom", currency: "GBP", status: "invited" });
  await ctx.db.insert("familyRequests", {
    userId,
    memberId: sister,
    direction: "incoming",
    note: "Textbooks for next semester",
    sendMinor: 952_000,
    sendCurrency: "INR",
    receiveMinor: 80_000,
    receiveCurrency: "CNY",
    feeMinor: 9_500,
    quoteExpiresAt: now + 25 * 60_000,
    state: "requested",
  });
  await ctx.db.insert("familyRequests", {
    userId,
    memberId: sister,
    direction: "outgoing",
    note: "October allowance",
    sendMinor: 1_540_000,
    sendCurrency: "INR",
    receiveMinor: 129_400,
    receiveCurrency: "CNY",
    feeMinor: 12_000,
    quoteExpiresAt: at(20),
    state: "received",
  });

  const events: Array<["payment" | "security" | "agent" | "import" | "setting", string, string | undefined, "neutral" | "good" | "warn" | "bad"]> = [
    ["agent", "OpenClaw frozen", "Tried to pay an address from a forwarded message", "bad"],
    ["payment", "Paid Blue Tokai $8.40", "Your assistant, within its daily limit", "good"],
    ["import", "Imported your HDFC statement", "September and October", "neutral"],
    ["agent", "Claude connected", "Read, prepare and spend up to $15 a day", "neutral"],
    ["security", "Signed in on a new device", "Chrome on Mac", "neutral"],
    ["setting", "Protected $50 in your wallet", "Agents can't spend it", "neutral"],
  ];
  for (const [kind, title, detail, tone] of events.reverse()) {
    await ctx.db.insert("activity", { userId, kind, title, detail, tone });
  }
}
