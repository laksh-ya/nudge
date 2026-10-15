import { Workpool } from "@convex-dev/workpool";
import { components } from "../_generated/api";

/**
 * Every transaction the backend sends (relayer and agent keys alike) runs here one at a time.
 * Two sends at once would otherwise read the same nonce and one would be dropped.
 */
export const relayer = new Workpool(components.relayer, { maxParallelism: 1 });
