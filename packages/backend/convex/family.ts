import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { own, requireViewer, viewer } from "./lib/auth";
import { newApprovalToken } from "./lib/seed";
import { formatMoney } from "@agent-wallet/domain";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewer(ctx);
    if (!user) return { members: [], requests: [] };
    const members = await ctx.db.query("family").withIndex("by_user", (q) => q.eq("userId", user._id)).take(50);
    const requests = await ctx.db
      .query("familyRequests")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(50);
    const names = new Map(members.map((m) => [m._id, m.name]));
    return { members, requests: requests.map((r) => ({ ...r, member: names.get(r.memberId) ?? "" })) };
  },
});

/** Approving a family request creates a payment that still needs the owner's own approval. */
export const respond = mutation({
  args: { requestId: v.id("familyRequests"), approve: v.boolean() },
  handler: async (ctx, { requestId, approve }) => {
    const user = await requireViewer(ctx);
    const request = await own(user, await ctx.db.get(requestId));
    if (request.state !== "requested") throw new Error("Already handled");
    if (!approve) {
      await ctx.db.patch(requestId, { state: "declined" });
      return null;
    }
    const member = await ctx.db.get(request.memberId);
    const payee = (await ctx.db.query("payees").withIndex("by_user", (q) => q.eq("userId", user._id)).take(200)).find(
      (p) => member && p.name.startsWith(member.name),
    );
    const token = newApprovalToken();
    await ctx.db.insert("tasks", {
      userId: user._id,
      title: `${request.note} for ${member?.name ?? "family"}`,
      channel: "family",
      payeeId: payee?._id,
      amountMinor: request.sendMinor,
      currency: request.sendCurrency,
      purpose: `${member?.name} receives ${formatMoney(request.receiveMinor, request.receiveCurrency)}`,
      state: "awaiting_approval",
      reason: "Family transfers always need you",
      rail: "simulator",
      approvalToken: token,
      expiresAt: request.quoteExpiresAt,
      updatedAt: Date.now(),
    });
    await ctx.db.patch(requestId, { state: "approved" });
    return token;
  },
});
