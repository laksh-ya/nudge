import { Workpool } from "@convex-dev/workpool";
import { components } from "../_generated/api";

/**
 * One queue per sending key, because two sends from one key at once would read the same nonce.
 *
 * - `relayer` is the guardian key. Only it may freeze or cancel, so those always run here. It is
 *   also lane 0.
 * - Lanes 1-3 are extra relayer keys (derived per deployment, funded from the guardian) for work
 *   anyone may submit: vault deploys, owner-signed actions, finalizing, releasing, agent gas.
 *   Each user sticks to one lane, so one busy sandbox can't hold up everyone else's approvals.
 *   `RELAYER_LANES` (1-4, default 1) turns them on once they are funded.
 * - Agent keys each send their own payments; they share a parallel pool with a lock per key.
 */
export const relayer = new Workpool(components.relayer, { maxParallelism: 1 });
const extraLanes = [
  new Workpool(components.lane1, { maxParallelism: 1 }),
  new Workpool(components.lane2, { maxParallelism: 1 }),
  new Workpool(components.lane3, { maxParallelism: 1 }),
];
export const agentPool = new Workpool(components.agents, { maxParallelism: 10 });

export const MAX_LANES = 1 + extraLanes.length;

export function laneCount() {
  const n = Math.floor(Number(process.env.RELAYER_LANES ?? 1));
  return Number.isFinite(n) ? Math.min(MAX_LANES, Math.max(1, n)) : 1;
}

/** The lane a user's chain work runs on: stable per user, spread across the lanes in use. */
export function laneOf(userId: string) {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (Math.imul(h, 31) + userId.charCodeAt(i)) >>> 0;
  return h % laneCount();
}

export function lanePool(lane: number) {
  return lane === 0 ? relayer : extraLanes[lane - 1]!;
}
