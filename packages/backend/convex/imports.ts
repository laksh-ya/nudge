import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { importKind } from "./schema";
import { own, requireViewer } from "./lib/auth";
import { ingest } from "./lib/ledger";

const MAX_ROWS = 2000;

const row = v.object({
  at: v.number(),
  amountMinor: v.number(),
  description: v.string(),
  balanceMinor: v.optional(v.number()),
  pending: v.optional(v.boolean()),
});

export const uploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireViewer(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

/** Post reviewed statement rows. The original file is kept as evidence when uploaded. */
export const commit = mutation({
  args: {
    accountId: v.id("accounts"),
    kind: importKind,
    fileName: v.optional(v.string()),
    fileId: v.optional(v.id("_storage")),
    rows: v.array(row),
  },
  handler: async (ctx, { accountId, kind, fileName, fileId, rows }) => {
    const user = await requireViewer(ctx);
    const account = await own(user, await ctx.db.get(accountId));
    if (rows.length > MAX_ROWS) throw new Error(`Import up to ${MAX_ROWS} rows at a time`);
    const importId = await ctx.db.insert("imports", {
      userId: user._id,
      accountId,
      kind,
      fileName: fileName?.slice(0, 120),
      fileId,
      rows: rows.length,
      added: 0,
      duplicates: 0,
      transfers: 0,
    });
    const result = await ingest(
      ctx,
      user,
      account,
      rows.map((r) => ({ ...r, description: r.description.slice(0, 200) })),
      importId,
    );
    await ctx.db.patch(importId, result);
    await ctx.db.insert("activity", {
      userId: user._id,
      kind: "import",
      title: `Imported ${result.added} transactions into ${account.name}`,
      detail: [
        fileName,
        result.duplicates ? `${result.duplicates} already known` : null,
        result.transfers ? `${result.transfers} transfers matched` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      tone: "good",
    });
    return result;
  },
});

/** One transaction typed in or read from a receipt. */
export const addOne = mutation({
  args: {
    accountId: v.id("accounts"),
    at: v.number(),
    amountMinor: v.number(),
    merchant: v.string(),
    category: v.optional(v.string()),
    note: v.optional(v.string()),
    receiptId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const user = await requireViewer(ctx);
    const account = await own(user, await ctx.db.get(args.accountId));
    const merchant = args.merchant.trim().slice(0, 80);
    if (!merchant) throw new Error("Add who it was paid to");
    const importId = await ctx.db.insert("imports", {
      userId: user._id,
      accountId: account._id,
      kind: args.receiptId ? "scan" : "manual",
      rows: 1,
      added: 0,
      duplicates: 0,
      transfers: 0,
    });
    const result = await ingest(
      ctx,
      user,
      account,
      [{ at: args.at, amountMinor: args.amountMinor, description: merchant, category: args.category, note: args.note?.slice(0, 200), receiptId: args.receiptId }],
      importId,
    );
    if (result.rows === 0) throw new Error("Check the date and amount");
    await ctx.db.patch(importId, result);
    return result;
  },
});
