import type { IncomingRow } from "./ledger";

/**
 * Sandbox connection: what a bank feed (Account Aggregator, Plaid, Open Banking) would return,
 * generated deterministically per account so the same account always gets the same history.
 */

type Profile = {
  salary: [string, number];
  rent: [string, number];
  monthly: [string, number][];
  everyday: [string, number, number][];
  scale: number;
};

const PROFILES: Record<string, Profile> = {
  IN: {
    salary: ["NEFT CR-ACME LABS PVT LTD-SALARY", 95_000],
    rent: ["UPI/DR/RENT/LANDLORD", 18_000],
    monthly: [["ACH D- NETFLIX ENTERTAINMENT", 649], ["POS SPOTIFY INDIA", 119], ["BILLDESK*BESCOM ELECTRICITY", 1_840], ["UPI/DR/AIRTEL POSTPAID", 599]],
    everyday: [["UPI/DR/SWIGGY", 180, 650], ["UPI/DR/ZOMATO", 200, 700], ["POS BIGBASKET", 600, 2_400], ["UPI/DR/UBER INDIA", 120, 480], ["UPI/DR/BLINKIT", 150, 900], ["POS AMAZON PAY INDIA", 300, 3_500], ["UPI/DR/THIRD WAVE COFFEE", 180, 420]],
    scale: 1,
  },
  CN: {
    salary: ["代发工资 深圳科技有限公司", 18_000],
    rent: ["房租 转账", 4_500],
    monthly: [["中国移动 话费", 128], ["爱奇艺 会员", 25], ["电费 深圳供电局", 210]],
    everyday: [["美团外卖", 25, 90], ["瑞幸咖啡", 9.9, 22], ["滴滴出行", 14, 60], ["盒马鲜生", 45, 260], ["淘宝", 59, 399], ["深圳地铁", 2, 9]],
    scale: 1,
  },
  US: {
    salary: ["ACME LABS PAYROLL", 5_400],
    rent: ["ZELLE RENT PAYMENT", 2_100],
    monthly: [["NETFLIX.COM", 15.49], ["SPOTIFY USA", 11.99], ["VERIZON WIRELESS", 65], ["CON EDISON", 92]],
    everyday: [["STARBUCKS", 5, 12], ["UBER TRIP", 12, 38], ["WHOLE FOODS", 30, 140], ["AMAZON.COM", 15, 120], ["DOORDASH", 18, 45], ["TRADER JOE'S", 25, 90]],
    scale: 1,
  },
  GB: {
    salary: ["ACME LABS LTD SALARY", 3_600],
    rent: ["STANDING ORDER RENT", 1_350],
    monthly: [["NETFLIX", 10.99], ["SPOTIFY", 11.99], ["EE LIMITED", 25], ["OCTOPUS ENERGY", 88]],
    everyday: [["TESCO STORES", 12, 70], ["PRET A MANGER", 4, 11], ["TFL TRAVEL", 3, 9], ["AMAZON UK", 10, 80], ["DELIVEROO", 15, 35]],
    scale: 1,
  },
};

function profileFor(country: string, currency: string): Profile {
  const p = PROFILES[country];
  if (p) return p;
  const fallback = PROFILES.US!;
  const scale = currency === "EUR" ? 0.92 : currency === "SGD" ? 1.3 : currency === "AED" ? 3.6 : currency === "HKD" ? 7.8 : currency === "JPY" ? 150 : currency === "AUD" ? 1.5 : currency === "CAD" ? 1.4 : 1;
  return { ...fallback, scale };
}

function rng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353), (h = (h << 13) | (h >>> 19));
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

export function sandboxHistory(seed: string, country: string, currency: string, decimals: number, days = 92) {
  const p = profileFor(country, currency);
  const r = rng(seed);
  const unit = 10 ** decimals;
  const money = (major: number) => Math.round(major * p.scale * unit) / unit;
  const rows: IncomingRow[] = [];
  const end = new Date();
  end.setUTCHours(12, 0, 0, 0);
  const start = end.getTime() - days * 86_400_000;
  for (let t = start; t <= end.getTime(); t += 86_400_000) {
    const d = new Date(t).getUTCDate();
    const push = (description: string, major: number) => rows.push({ at: t, amountMinor: Math.round(money(major) * unit), description });
    if (d === 1) push(p.salary[0], p.salary[1]);
    if (d === 3) push(p.rent[0], -p.rent[1]);
    p.monthly.forEach(([name, amt], i) => {
      if (d === 5 + i * 4) push(name, -amt);
    });
    const n = r() < 0.25 ? 0 : r() < 0.7 ? 1 : 2;
    for (let i = 0; i < n; i++) {
      const [name, lo, hi] = p.everyday[Math.floor(r() * p.everyday.length)]!;
      push(name, -Math.round((lo + r() * (hi - lo)) * 100) / 100);
    }
  }
  // Opening balance chosen so the account stays comfortably positive.
  let balance = Math.round(money(p.salary[1] * (0.6 + r() * 0.5)) * unit);
  for (const row of rows) {
    balance += row.amountMinor;
    row.balanceMinor = balance;
  }
  return rows;
}
