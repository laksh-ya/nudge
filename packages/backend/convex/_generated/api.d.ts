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
import type * as connections from "../connections.js";
import type * as crons from "../crons.js";
import type * as crypto from "../crypto.js";
import type * as demo from "../demo.js";
import type * as family from "../family.js";
import type * as gateway from "../gateway.js";
import type * as home from "../home.js";
import type * as http from "../http.js";
import type * as imports from "../imports.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_hash from "../lib/hash.js";
import type * as lib_ledger from "../lib/ledger.js";
import type * as lib_overview from "../lib/overview.js";
import type * as lib_sandbox from "../lib/sandbox.js";
import type * as lib_seed from "../lib/seed.js";
import type * as lib_wipe from "../lib/wipe.js";
import type * as messages from "../messages.js";
import type * as migrations from "../migrations.js";
import type * as money from "../money.js";
import type * as onboarding from "../onboarding.js";
import type * as rates from "../rates.js";
import type * as tasks from "../tasks.js";
import type * as telegram from "../telegram.js";
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
  connections: typeof connections;
  crons: typeof crons;
  crypto: typeof crypto;
  demo: typeof demo;
  family: typeof family;
  gateway: typeof gateway;
  home: typeof home;
  http: typeof http;
  imports: typeof imports;
  "lib/auth": typeof lib_auth;
  "lib/hash": typeof lib_hash;
  "lib/ledger": typeof lib_ledger;
  "lib/overview": typeof lib_overview;
  "lib/sandbox": typeof lib_sandbox;
  "lib/seed": typeof lib_seed;
  "lib/wipe": typeof lib_wipe;
  messages: typeof messages;
  migrations: typeof migrations;
  money: typeof money;
  onboarding: typeof onboarding;
  rates: typeof rates;
  tasks: typeof tasks;
  telegram: typeof telegram;
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
