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
import type * as bhaiMail from "../bhaiMail.js";
import type * as bhaiMailHelpers from "../bhaiMailHelpers.js";
import type * as bhaiMailNode from "../bhaiMailNode.js";
import type * as claude from "../claude.js";
import type * as contact from "../contact.js";
import type * as credit_cost from "../credit_cost.js";
import type * as crons from "../crons.js";
import type * as crypto from "../crypto.js";
import type * as devices from "../devices.js";
import type * as errorLog from "../errorLog.js";
import type * as grok from "../grok.js";
import type * as http from "../http.js";
import type * as llmCallLog from "../llmCallLog.js";
import type * as llmStream from "../llmStream.js";
import type * as llmUsage from "../llmUsage.js";
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
import type * as streamFrames from "../streamFrames.js";
import type * as stt from "../stt.js";
import type * as systemContent from "../systemContent.js";
import type * as telegramManaged from "../telegramManaged.js";
import type * as updateFeed from "../updateFeed.js";
import type * as userAddenda from "../userAddenda.js";
import type * as waitlist from "../waitlist.js";
import type * as waitlistMailer from "../waitlistMailer.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accounts: typeof accounts;
  appRuntime: typeof appRuntime;
  bhaiMail: typeof bhaiMail;
  bhaiMailHelpers: typeof bhaiMailHelpers;
  bhaiMailNode: typeof bhaiMailNode;
  claude: typeof claude;
  contact: typeof contact;
  credit_cost: typeof credit_cost;
  crons: typeof crons;
  crypto: typeof crypto;
  devices: typeof devices;
  errorLog: typeof errorLog;
  grok: typeof grok;
  http: typeof http;
  llmCallLog: typeof llmCallLog;
  llmStream: typeof llmStream;
  llmUsage: typeof llmUsage;
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
  streamFrames: typeof streamFrames;
  stt: typeof stt;
  systemContent: typeof systemContent;
  telegramManaged: typeof telegramManaged;
  updateFeed: typeof updateFeed;
  userAddenda: typeof userAddenda;
  waitlist: typeof waitlist;
  waitlistMailer: typeof waitlistMailer;
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
