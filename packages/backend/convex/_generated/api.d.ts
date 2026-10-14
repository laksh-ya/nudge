/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as activity from "../activity.js";
import type * as agents from "../agents.js";
import type * as approvals from "../approvals.js";
import type * as demo from "../demo.js";
import type * as family from "../family.js";
import type * as home from "../home.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_overview from "../lib/overview.js";
import type * as lib_seed from "../lib/seed.js";
import type * as messages from "../messages.js";
import type * as money from "../money.js";
import type * as tasks from "../tasks.js";
import type * as users from "../users.js";
import type * as wallet from "../wallet.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  activity: typeof activity;
  agents: typeof agents;
  approvals: typeof approvals;
  demo: typeof demo;
  family: typeof family;
  home: typeof home;
  "lib/auth": typeof lib_auth;
  "lib/overview": typeof lib_overview;
  "lib/seed": typeof lib_seed;
  messages: typeof messages;
  money: typeof money;
  tasks: typeof tasks;
  users: typeof users;
  wallet: typeof wallet;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
