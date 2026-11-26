import * as environment from "wasi:cli/environment@0.2.12";
import * as preopens from "wasi:filesystem/preopens@0.2.12";

import { createWasiHost } from "../createWasiHost";
import { fromWasiRegion as regionWithHost } from "../fromWasiRegion";
import { type WasiDefaultProviderInit, wasiDefaultProvider as chainWithHost } from "../wasiDefaultProvider";
import type { WasiHost, WasiProviderInit } from "../WasiHost";

/**
 * @public
 *
 * {@link WasiHost} backed by the component's `wasi:cli/environment@0.2.12` and
 * `wasi:filesystem/preopens@0.2.12` imports. Importing this module therefore
 * requires the component's world to import those interfaces.
 */
export const wasiHost: WasiHost = createWasiHost(environment, preopens);

type WithoutHost<T> = Omit<T, "host"> & { host?: WasiHost };

/**
 * @public
 *
 * {@link wasiDefaultProvider} bound to {@link wasiHost}.
 */
export const wasiDefaultProvider = (init: WithoutHost<WasiDefaultProviderInit> = {}) =>
  chainWithHost({ ...init, host: init.host ?? wasiHost });

/**
 * @public
 *
 * {@link fromWasiRegion} bound to {@link wasiHost}.
 */
export const fromWasiRegion = (init: WithoutHost<WasiProviderInit> = {}) =>
  regionWithHost({ ...init, host: init.host ?? wasiHost });
