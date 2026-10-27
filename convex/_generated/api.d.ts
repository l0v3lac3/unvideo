/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as http from "../http.js";
import type * as proxy from "../proxy.js";
import type * as sources_91porn from "../sources/91porn.js";
import type * as sources_cg51 from "../sources/cg51.js";
import type * as sources_index from "../sources/index.js";
import type * as sources_rou from "../sources/rou.js";
import type * as sources_t66y from "../sources/t66y.js";
import type * as sources_types from "../sources/types.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  http: typeof http;
  proxy: typeof proxy;
  "sources/91porn": typeof sources_91porn;
  "sources/cg51": typeof sources_cg51;
  "sources/index": typeof sources_index;
  "sources/rou": typeof sources_rou;
  "sources/t66y": typeof sources_t66y;
  "sources/types": typeof sources_types;
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
