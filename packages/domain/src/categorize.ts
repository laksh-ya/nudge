/** Keyword categories for merchant names, including common Chinese merchant names. */
const RULES: [string, RegExp][] = [
  ["Transfer", /\b(cc|credit card|card)\b.*\b(payment|repayment|bill pay)\b|\b(autopay|payment received).*\bcard\b|\bself transfer\b|\bown account\b|信用卡还款|还款/i],
  ["Income", /\b(salary|payroll|sal cr|neft cr.*sal|wages|paycheck|dividend|interest (paid|credit)|refund of tax)\b|工资|薪资/i],
  ["Rent", /\b(rent|landlord|lease|nobroker|housing)\b|房租|租金/i],
  ["Bills", /\b(electric|bescom|tneb|msedcl|adani|tata power|water|gas|broadband|airtel|jio|vodafone|vi postpaid|bsnl|verizon|at&t|t-mobile|comcast|xfinity|bt group|ee limited|china mobile|china unicom|utility|insurance|premium|emi)\b|电费|水费|话费|中国移动|中国联通|燃气|保险/i],
  ["Subscriptions", /\b(netflix|spotify|youtube premium|prime video|amazon prime|hotstar|jiocinema|apple\.com|icloud|google one|chatgpt|openai|anthropic|claude|notion|figma|adobe|microsoft 365|dropbox|cult\.?fit|gym|bilibili|iqiyi|腾讯视频|爱奇艺|会员)\b/i],
  ["Food", /\b(swiggy|zomato|ubereats|uber eats|doordash|deliveroo|starbucks|cafe|coffee|restaurant|pizza|mcdonald|kfc|domino|burger|dining|third wave|blue tokai|chaayos|pret|meituan|eleme)\b|美团|饿了么|餐|咖啡|奶茶|瑞幸|喜茶/i],
  ["Groceries", /\b(bigbasket|blinkit|zepto|instamart|dmart|reliance fresh|more retail|grofers|whole foods|trader joe|walmart|costco|tesco|sainsbury|aldi|lidl|fairprice|hema|freshippo)\b|盒马|超市|叮咚|永辉/i],
  ["Travel", /\b(uber|ola|rapido|lyft|metro|irctc|indigo|air india|vistara|akasa|makemytrip|goibibo|cleartrip|airbnb|booking\.com|hotel|tfl|mrt|grab|didi|fuel|petrol|shell|hpcl|bpcl|iocl|parking|fastag)\b|滴滴|高铁|12306|携程|地铁|加油/i],
  ["Shopping", /\b(amazon|flipkart|myntra|ajio|nykaa|meesho|decathlon|ikea|target|best buy|ebay|etsy|zara|h&m|uniqlo|taobao|tmall|jd\.com|pinduoduo|shein|apple store)\b|淘宝|天猫|京东|拼多多/i],
  ["Health", /\b(pharmacy|apollo|medplus|1mg|pharmeasy|netmeds|hospital|clinic|doctor|dental|diagnostic|lab)\b|医院|药房|药店/i],
  ["Fun", /\b(pvr|inox|bookmyshow|cinema|movie|steam|playstation|xbox|nintendo|concert|spotify live)\b|电影|游戏/i],
  ["Education", /\b(tuition|school|college|university|course|udemy|coursera|byju|unacademy|books?)\b|学费|教材|书店/i],
  ["Cash", /\b(atm|cash withdrawal|cash wdl|nwd)\b|取现/i],
  ["Family", /\b(allowance|pocket money|mom|mum|dad|papa|mummy|family)\b|家人|生活费/i],
  ["Crypto", /\b(binance|coinbase|wazirx|coindcx|okx|kraken|bybit)\b/i],
];

export const CATEGORIES = [
  "Food",
  "Groceries",
  "Shopping",
  "Travel",
  "Bills",
  "Rent",
  "Subscriptions",
  "Health",
  "Fun",
  "Education",
  "Family",
  "Cash",
  "Crypto",
  "Income",
  "Transfer",
  "Other",
] as const;

export function categorize(merchant: string, amountMinor: number): string {
  for (const [category, re] of RULES) {
    if (re.test(merchant)) {
      if (category === "Income" && amountMinor < 0) continue;
      return category;
    }
  }
  return amountMinor > 0 ? "Income" : "Other";
}

/** Strip reference numbers and payment-rail noise so the same merchant groups together. */
export function normalizeMerchant(raw: string): string {
  let s = raw.trim();
  // UPI narrations: UPI/DR/123456789/SWIGGY/YESB/... -> SWIGGY
  const upi = s.match(/^UPI[-/](?:DR|CR|P2M|P2A)?[-/]?\d*[-/]([^-/]+)/i);
  if (upi?.[1]) s = upi[1];
  // Bank transfers: IMPS-ANANYA MEHTA-ALLOWANCE, NEFT CR-ACME LABS PVT LTD-SALARY -> the party
  const rail = s.match(/^(?:IMPS|NEFT|RTGS)(?:\s?(?:CR|DR))?[-/ ]+([^-/]+)/i);
  if (rail?.[1]) s = rail[1];
  s = s
    .replace(/\bACH\s*[DC]\s*-/gi, " ")
    .replace(/\b[\dX*]*X{2,}[\dX*]*\b/g, " ")
    .replace(/\b(POS|ECOM|NEFT|IMPS|RTGS|ACH|DEBIT|CREDIT|CARD|TXN|PURCHASE|PAYMENT|VPA|REF|NO|DR|CR|BILLDESK|PVT|LTD)\b/gi, " ")
    .replace(/[*#]+/g, " ")
    .replace(/\b(?=[A-Z0-9]*\d)[A-Z0-9]{10,}\b/g, " ")
    .replace(/\d{4,}/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-/.:,]+|[\s\-/.:,]+$/g, "")
    .trim();
  if (!s) s = raw.trim();
  return s.length > 48 ? s.slice(0, 48).trim() : s;
}

export function merchantKey(name: string): string {
  return normalizeMerchant(name)
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 2)
    .join(" ");
}

export function titleCase(s: string): string {
  if (/[一-鿿]/.test(s)) return s;
  return s
    .split(/(\s+)/)
    .map((w, i) => {
      if (/^\s+$/.test(w)) return w;
      const lower = w.toLowerCase();
      if (i > 0 && SMALL.has(lower)) return lower;
      // Keep acronyms: USA, UPI, ATM, and known bank and network names.
      if ((/^[A-Z]{2,3}$/.test(w) && !/^(THE|AND|FOR|PAY|BAR|CAB|BUS|CAR|INC|LTD|NEW|ONE|BIG)$/.test(w)) || ACRONYMS.has(w)) return w;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}

const SMALL = new Set(["of", "the", "and", "to", "for", "at", "on", "in", "by"]);
const ACRONYMS = new Set(["HDFC", "ICICI", "IDFC", "BSNL", "IRCTC", "BESCOM", "TNEB", "IKEA", "NETS", "DBS", "OCBC", "HSBC", "BMO", "RBC"]);
