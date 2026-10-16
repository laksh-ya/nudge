import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { isSandbox } from "./auth";
import { hit, tryHit } from "./limits";

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Vault deployments across every account. Each costs the relayer test ETH. */
export const DEPLOYS_PER_HOUR = 60;
/** Demo sandboxes together, per day: room for every judge and then some. */
export const SANDBOX_DEPLOYS_PER_DAY = 150;
/** One visitor (one network address) per day, however many sandboxes they open. */
export const VISITOR_DEPLOYS_PER_DAY = 3;
/** Below this many sandboxes' worth of test ETH, new sandbox vaults wait so the judge account keeps working. */
export const RUNWAY_RESERVE = 5;

/** Assistant turns per day. Sandboxes are anonymous, so they get a smaller share and a smaller model. */
export const ASSISTANT_TURNS = { sandbox: 30, sandboxesTotal: 1500, member: 200 } as const;

/** Who is asking: the hashed network address the demo token carries, or the account itself. */
async function visitorOf(ctx: MutationCtx, user: Doc<"users">) {
  const identity = await ctx.auth.getUserIdentity();
  const vis = identity?.vis;
  return typeof vis === "string" && /^[a-f0-9]{16,64}$/.test(vis) ? vis : user._id;
}

/** Spend one vault deployment from every budget it counts against, or throw saying which is used up. */
export async function spendDeploy(ctx: MutationCtx, user: Doc<"users">) {
  await hit(ctx, "deploys", DEPLOYS_PER_HOUR, HOUR, "Too many wallets are being created right now. Try again in a few minutes.");
  if (!isSandbox(user)) return;
  const runway = await ctx.db.query("ops").withIndex("by_key", (q) => q.eq("key", "relayer")).unique();
  if (runway && runway.runway < RUNWAY_RESERVE) throw new Error("The demo's test ETH is being topped up. Try again in a little while.");
  await hit(ctx, `deploys:visitor:${await visitorOf(ctx, user)}`, VISITOR_DEPLOYS_PER_DAY, DAY, `You've made ${VISITOR_DEPLOYS_PER_DAY} demo vaults today. Keep using one of them, or come back tomorrow.`);
  await hit(ctx, "deploys:sandbox", SANDBOX_DEPLOYS_PER_DAY, DAY, "Demo vaults are used up for today. Sign up, or try again tomorrow.");
}

/** Whether this turn may use the model. Over the quota the assistant still answers, without it. */
export async function spendAssistantTurn(ctx: MutationCtx, user: Doc<"users">) {
  if (!isSandbox(user)) return await tryHit(ctx, `assistant:${user._id}`, ASSISTANT_TURNS.member, DAY);
  return (
    (await tryHit(ctx, `assistant:${user._id}`, ASSISTANT_TURNS.sandbox, DAY)) &&
    (await tryHit(ctx, "assistant:sandboxes", ASSISTANT_TURNS.sandboxesTotal, DAY))
  );
}
