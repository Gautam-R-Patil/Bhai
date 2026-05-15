/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accounts from "../accounts.js";
import type * as appRuntime from "../appRuntime.js";
import type * as credit_cost from "../credit_cost.js";
import type * as crypto from "../crypto.js";
import type * as http from "../http.js";
import type * as observability from "../observability.js";
import type * as otpless from "../otpless.js";
import type * as sessions from "../sessions.js";
import type * as store_admins from "../store/admins.js";
import type * as store_developers from "../store/developers.js";
import type * as store_installs from "../store/installs.js";
import type * as store_items from "../store/items.js";
import type * as store_reviews from "../store/reviews.js";
import type * as store_storage from "../store/storage.js";
import type * as store_submissions from "../store/submissions.js";
import type * as systemContent from "../systemContent.js";
import type * as userAddenda from "../userAddenda.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accounts: typeof accounts;
  appRuntime: typeof appRuntime;
  credit_cost: typeof credit_cost;
  crypto: typeof crypto;
  http: typeof http;
  observability: typeof observability;
  otpless: typeof otpless;
  sessions: typeof sessions;
  "store/admins": typeof store_admins;
  "store/developers": typeof store_developers;
  "store/installs": typeof store_installs;
  "store/items": typeof store_items;
  "store/reviews": typeof store_reviews;
  "store/storage": typeof store_storage;
  "store/submissions": typeof store_submissions;
  systemContent: typeof systemContent;
  userAddenda: typeof userAddenda;
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
