import type { Currency } from "./money";

export type SourceKind = "bank" | "card" | "payment_app" | "crypto" | "transfer" | "cash";

/** What a connection is able to do. Connecting never grants spending authority by itself. */
export type Capability = "read" | "prepare" | "handoff" | "execute";

export const CAPABILITY_LABEL: Record<Capability, string> = {
  read: "See balance and history",
  prepare: "Prepare payments",
  handoff: "You approve in its app",
  execute: "Agents pay within limits",
};

export type ConnectMethod = "sandbox" | "statement" | "onchain" | "manual";

export const METHOD_LABEL: Record<ConnectMethod, string> = {
  sandbox: "Connect",
  statement: "Statement",
  onchain: "On-chain",
  manual: "Manual",
};

export type Country = {
  code: string;
  name: string;
  currency: Currency;
  timezone: string;
  dateOrder: "dmy" | "mdy" | "ymd";
  /** Open-banking style network available in this country, if any. */
  bankNetwork?: string;
};

export const COUNTRIES: Country[] = [
  { code: "IN", name: "India", currency: "INR", timezone: "Asia/Kolkata", dateOrder: "dmy", bankNetwork: "Account Aggregator" },
  { code: "CN", name: "China", currency: "CNY", timezone: "Asia/Shanghai", dateOrder: "ymd" },
  { code: "US", name: "United States", currency: "USD", timezone: "America/New_York", dateOrder: "mdy", bankNetwork: "Plaid" },
  { code: "GB", name: "United Kingdom", currency: "GBP", timezone: "Europe/London", dateOrder: "dmy", bankNetwork: "Open Banking" },
  { code: "DE", name: "Germany", currency: "EUR", timezone: "Europe/Berlin", dateOrder: "dmy", bankNetwork: "Open Banking" },
  { code: "SG", name: "Singapore", currency: "SGD", timezone: "Asia/Singapore", dateOrder: "dmy" },
  { code: "AE", name: "United Arab Emirates", currency: "AED", timezone: "Asia/Dubai", dateOrder: "dmy" },
  { code: "HK", name: "Hong Kong", currency: "HKD", timezone: "Asia/Hong_Kong", dateOrder: "dmy" },
  { code: "JP", name: "Japan", currency: "JPY", timezone: "Asia/Tokyo", dateOrder: "ymd" },
  { code: "AU", name: "Australia", currency: "AUD", timezone: "Australia/Sydney", dateOrder: "dmy", bankNetwork: "Open Banking" },
  { code: "CA", name: "Canada", currency: "CAD", timezone: "America/Toronto", dateOrder: "mdy", bankNetwork: "Plaid" },
];

export function country(code: string | undefined): Country {
  return COUNTRIES.find((c) => c.code === code) ?? COUNTRIES[0]!;
}

export type Provider = {
  id: string;
  name: string;
  kind: SourceKind;
  countries?: string[];
  methods: ConnectMethod[];
  can: Capability[];
  /** Short hint shown under the name. */
  note?: string;
};

const BANKS: Record<string, string[]> = {
  IN: ["HDFC Bank", "ICICI Bank", "State Bank of India", "Axis Bank", "Kotak Mahindra Bank", "IDFC FIRST Bank"],
  CN: ["ICBC", "China Construction Bank", "Bank of China", "China Merchants Bank", "Agricultural Bank of China"],
  US: ["Chase", "Bank of America", "Wells Fargo", "Citi", "Capital One"],
  GB: ["Barclays", "HSBC UK", "Lloyds", "Monzo", "Revolut"],
  DE: ["Deutsche Bank", "Commerzbank", "N26", "Sparkasse"],
  SG: ["DBS", "OCBC", "UOB"],
  AE: ["Emirates NBD", "ADCB", "Mashreq"],
  HK: ["HSBC Hong Kong", "Hang Seng Bank", "Bank of China (Hong Kong)"],
  JP: ["MUFG", "SMBC", "Mizuho"],
  AU: ["Commonwealth Bank", "ANZ", "Westpac", "NAB"],
  CA: ["RBC", "TD", "Scotiabank", "BMO"],
};

export function banksFor(countryCode: string): Provider[] {
  const c = country(countryCode);
  return (BANKS[c.code] ?? []).map((name) => ({
    id: `bank:${c.code}:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name,
    kind: "bank" as const,
    countries: [c.code],
    methods: c.bankNetwork ? ["sandbox", "statement", "manual"] : ["statement", "manual"],
    can: ["read"],
    note: c.bankNetwork ? `${c.bankNetwork} or statement` : "Statement or manual",
  }));
}

export const PAYMENT_APPS: Provider[] = [
  { id: "app:paytm", name: "Paytm", kind: "payment_app", countries: ["IN"], methods: ["statement", "manual"], can: ["read", "handoff"], note: "UPI" },
  { id: "app:phonepe", name: "PhonePe", kind: "payment_app", countries: ["IN"], methods: ["statement", "manual"], can: ["read", "handoff"], note: "UPI" },
  { id: "app:gpay", name: "Google Pay", kind: "payment_app", countries: ["IN", "US", "SG"], methods: ["statement", "manual"], can: ["read", "handoff"], note: "UPI" },
  { id: "app:alipay", name: "Alipay", kind: "payment_app", countries: ["CN", "HK"], methods: ["statement", "manual"], can: ["read", "handoff"], note: "支付宝 bill export" },
  { id: "app:wechat", name: "WeChat Pay", kind: "payment_app", countries: ["CN", "HK"], methods: ["statement", "manual"], can: ["read", "handoff"], note: "微信支付 bill export" },
  { id: "app:paypal", name: "PayPal", kind: "payment_app", methods: ["statement", "manual"], can: ["read", "handoff"], note: "Activity CSV" },
  { id: "app:venmo", name: "Venmo", kind: "payment_app", countries: ["US"], methods: ["statement", "manual"], can: ["read", "handoff"] },
  { id: "app:grabpay", name: "GrabPay", kind: "payment_app", countries: ["SG"], methods: ["statement", "manual"], can: ["read", "handoff"] },
];

export const CARD_NETWORKS = ["Visa", "Mastercard", "RuPay", "UnionPay", "American Express", "JCB"] as const;

export const TRANSFER_PROVIDERS: Provider[] = [
  { id: "transfer:wise", name: "Wise", kind: "transfer", methods: ["sandbox", "statement", "manual"], can: ["read", "prepare", "handoff"], note: "Quotes and transfers" },
  { id: "transfer:remitly", name: "Remitly", kind: "transfer", methods: ["statement", "manual"], can: ["read"] },
  { id: "transfer:westernunion", name: "Western Union", kind: "transfer", methods: ["manual"], can: ["read"] },
];

export type Chain = {
  id: string;
  name: string;
  family: "evm" | "bitcoin" | "solana";
  native: string;
  coingecko: string;
  rpc?: string;
  chainId?: number;
  explorer: string;
  testnet?: boolean;
  /** Stablecoin contracts read alongside the native balance. */
  tokens?: { symbol: string; address: `0x${string}`; decimals: number; coingecko: string }[];
};

export const CHAINS: Chain[] = [
  {
    id: "ethereum", name: "Ethereum", family: "evm", native: "ETH", coingecko: "ethereum", chainId: 1,
    rpc: "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io/address/",
    tokens: [
      { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, coingecko: "usd-coin" },
      { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, coingecko: "tether" },
    ],
  },
  {
    id: "base", name: "Base", family: "evm", native: "ETH", coingecko: "ethereum", chainId: 8453,
    rpc: "https://base-rpc.publicnode.com", explorer: "https://basescan.org/address/",
    tokens: [{ symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, coingecko: "usd-coin" }],
  },
  {
    id: "arbitrum", name: "Arbitrum", family: "evm", native: "ETH", coingecko: "ethereum", chainId: 42161,
    rpc: "https://arbitrum-one-rpc.publicnode.com", explorer: "https://arbiscan.io/address/",
    tokens: [{ symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, coingecko: "usd-coin" }],
  },
  {
    id: "optimism", name: "Optimism", family: "evm", native: "ETH", coingecko: "ethereum", chainId: 10,
    rpc: "https://optimism-rpc.publicnode.com", explorer: "https://optimistic.etherscan.io/address/",
    tokens: [{ symbol: "USDC", address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6, coingecko: "usd-coin" }],
  },
  {
    id: "polygon", name: "Polygon", family: "evm", native: "POL", coingecko: "polygon-ecosystem-token", chainId: 137,
    rpc: "https://polygon-bor-rpc.publicnode.com", explorer: "https://polygonscan.com/address/",
    tokens: [{ symbol: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, coingecko: "usd-coin" }],
  },
  {
    id: "bsc", name: "BNB Chain", family: "evm", native: "BNB", coingecko: "binancecoin", chainId: 56,
    rpc: "https://bsc-rpc.publicnode.com", explorer: "https://bscscan.com/address/",
    tokens: [{ symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, coingecko: "tether" }],
  },
  {
    id: "base-sepolia", name: "Base Sepolia", family: "evm", native: "ETH", coingecko: "", chainId: 84532, testnet: true,
    rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org/address/",
    tokens: [{ symbol: "USDC", address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6, coingecko: "" }],
  },
  { id: "bitcoin", name: "Bitcoin", family: "bitcoin", native: "BTC", coingecko: "bitcoin", explorer: "https://mempool.space/address/" },
  { id: "solana", name: "Solana", family: "solana", native: "SOL", coingecko: "solana", rpc: "https://api.mainnet-beta.solana.com", explorer: "https://solscan.io/account/" },
];

export const EXCHANGES: Provider[] = [
  { id: "exchange:binance", name: "Binance", kind: "crypto", methods: ["statement", "manual"], can: ["read"], note: "Transaction history CSV" },
  { id: "exchange:coinbase", name: "Coinbase", kind: "crypto", methods: ["statement", "manual"], can: ["read"], note: "Transaction history CSV" },
  { id: "exchange:okx", name: "OKX", kind: "crypto", methods: ["statement", "manual"], can: ["read"] },
  { id: "exchange:wazirx", name: "WazirX", kind: "crypto", countries: ["IN"], methods: ["statement", "manual"], can: ["read"] },
];

/** Classify an address the user pastes. */
export function detectAddress(input: string): "evm" | "bitcoin" | "solana" | null {
  const a = input.trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(a)) return "evm";
  if (/^(bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(a)) return "bitcoin";
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return "solana";
  return null;
}

export const PRIORITIES = [
  { id: "spending", label: "Track spending" },
  { id: "bills", label: "Never miss a bill" },
  { id: "savings", label: "Save for goals" },
  { id: "agents", label: "Let AI agents pay" },
  { id: "family", label: "Send money to family" },
  { id: "crypto", label: "Track crypto" },
  { id: "shopping", label: "Shop smarter" },
] as const;

export const PREFERRED_USES = ["Everyday", "Bills", "Shopping", "Savings", "Transfers", "Crypto"] as const;
