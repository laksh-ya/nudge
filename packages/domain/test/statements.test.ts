import { readFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import { describe, expect, it } from "vitest";
import { categorize, merchantKey, normalizeMerchant, titleCase } from "../src/categorize";
import { convert, formatMoney } from "../src/money";
import { findHeaderRow, guessMapping, linesToTransactions, parseAmount, parseDate, parseReceipt, rowsToTransactions } from "../src/statements";

const samples = join(__dirname, "../../../apps/web/public/samples");

function load(file: string, order: "dmy" | "mdy" | "ymd") {
  const rows = Papa.parse<string[]>(readFileSync(join(samples, file), "utf8"), { skipEmptyLines: true }).data;
  const header = findHeaderRow(rows);
  const mapping = guessMapping(rows[header]!);
  return { header, mapping, tx: rowsToTransactions(rows.slice(header + 1), mapping, { order }) };
}

describe("amounts and dates", () => {
  it("parses Indian, European and accounting formats", () => {
    expect(parseAmount("1,23,456.78")).toBe(123456.78);
    expect(parseAmount("(45.00)")).toBe(-45);
    expect(parseAmount("₹ 500 Dr")).toBe(-500);
    expect(parseAmount("1.234,56")).toBe(1234.56);
    expect(parseAmount("")).toBeNull();
  });
  it("parses statement dates", () => {
    expect(new Date(parseDate("14/07/26", "dmy")!).toISOString().slice(0, 10)).toBe("2026-07-14");
    expect(new Date(parseDate("07/14/2026", "mdy")!).toISOString().slice(0, 10)).toBe("2026-07-14");
    expect(new Date(parseDate("2026-07-14 09:53:02")!).toISOString().slice(0, 10)).toBe("2026-07-14");
    expect(new Date(parseDate("14 Jul 2026")!).toISOString().slice(0, 10)).toBe("2026-07-14");
    expect(parseDate("not a date")).toBeNull();
  });
});

describe("statement files", () => {
  it("reads an HDFC export with a preamble and split debit/credit columns", () => {
    const { header, mapping, tx } = load("hdfc-savings-sample.csv", "dmy");
    expect(header).toBe(2);
    expect(mapping).toMatchObject({ date: 0, description: 1, debit: 4, credit: 5, balance: 6 });
    expect(tx.length).toBe(111);
    const salary = tx.find((t) => /SALARY/.test(t.description))!;
    expect(salary.amountMinor).toBe(9_500_000);
    expect(tx.at(-1)!.balanceMinor).toBe(8_704_941);
  });
  it("reads an Alipay bill export and its 收/支 column", () => {
    const { mapping, tx } = load("alipay-sample.csv", "ymd");
    expect(mapping.direction).toBe(5);
    expect(tx.length).toBe(99);
    expect(tx.every((t) => (/Aarav/.test(t.description) ? t.amountMinor > 0 : t.amountMinor < 0))).toBe(true);
  });
  it("reads PDF-style lines using the running balance for direction", () => {
    const rows = linesToTransactions([
      "01/10/2026 SALARY ACME LABS 95,000.00 1,52,000.00",
      "03/10/2026 RENT RAMESH 18,000.00 1,34,000.00",
      "05/10/2026 NETFLIX 649.00 1,33,351.00",
    ]);
    expect(rows.map((r) => r.amountMinor)).toEqual([-9_500_000, -1_800_000, -64_900]);
  });
});

describe("merchants and categories", () => {
  it("cleans UPI narrations", () => {
    expect(normalizeMerchant("UPI/DR/4471209931/SWIGGY/YESB")).toBe("SWIGGY");
    expect(merchantKey("POS 514002 BIGBASKET")).toBe("bigbasket");
    expect(normalizeMerchant("IMPS-ANANYA MEHTA-ALLOWANCE")).toBe("ANANYA MEHTA");
    expect(normalizeMerchant("NEFT CR-ACME LABS PVT LTD-SALARY OCT")).toBe("ACME LABS");
    expect(titleCase("RAMESH IYER")).toBe("Ramesh Iyer");
    expect(titleCase(normalizeMerchant("ACH D- NETFLIX ENTERTAINMENT"))).toBe("Netflix Entertainment");
    expect(titleCase(normalizeMerchant("POS 4521XXXX SPOTIFY INDIA"))).toBe("Spotify India");
    expect(categorize("CC 1093 PAYMENT ICICI BANK", -2_000_000)).toBe("Transfer");
  });
  it("title-cases merchant names without mangling acronyms or domains", () => {
    expect(titleCase("SPOTIFY USA")).toBe("Spotify USA");
    expect(titleCase("AMAZON.COM")).toBe("Amazon.com");
    expect(titleCase("TRADER JOE'S")).toBe("Trader Joe's");
  });
  it("categorises English and Chinese merchants", () => {
    expect(categorize("SWIGGY", -38900)).toBe("Food");
    expect(categorize("美团外卖", -5000)).toBe("Food");
    expect(categorize("滴滴出行", -3000)).toBe("Travel");
    expect(categorize("ACME LABS SALARY", 9_500_000)).toBe("Income");
  });
  it("reads a receipt total", () => {
    const r = parseReceipt("BLUE TOKAI COFFEE\nDate: 12/10/2026\nLatte 280.00\nTotal 483.00");
    expect(r.total).toBe(483);
    expect(r.merchant).toBe("BLUE TOKAI COFFEE");
  });
});

describe("money", () => {
  it("formats and converts", () => {
    expect(formatMoney(184_000, "INR")).toBe("₹1,840");
    expect(formatMoney(1_800, "USDC")).toBe("$18.00");
    expect(convert(10_000, "USD", "INR", { INR: 95, USD: 1 })).toBe(950_000);
  });
});
