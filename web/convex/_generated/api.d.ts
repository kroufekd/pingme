/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ResendOTP from "../ResendOTP.js";
import type * as auth from "../auth.js";
import type * as cleanup from "../cleanup.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as inviteLinks from "../inviteLinks.js";
import type * as invites from "../invites.js";
import type * as mac from "../mac.js";
import type * as macFeed from "../macFeed.js";
import type * as macaly from "../macaly.js";
import type * as mcp from "../mcp.js";
import type * as model from "../model.js";
import type * as pin from "../pin.js";
import type * as relay from "../relay.js";
import type * as senders from "../senders.js";
import type * as tasks from "../tasks.js";
import type * as validators from "../validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  ResendOTP: typeof ResendOTP;
  auth: typeof auth;
  cleanup: typeof cleanup;
  crons: typeof crons;
  http: typeof http;
  inviteLinks: typeof inviteLinks;
  invites: typeof invites;
  mac: typeof mac;
  macFeed: typeof macFeed;
  macaly: typeof macaly;
  mcp: typeof mcp;
  model: typeof model;
  pin: typeof pin;
  relay: typeof relay;
  senders: typeof senders;
  tasks: typeof tasks;
  validators: typeof validators;
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
