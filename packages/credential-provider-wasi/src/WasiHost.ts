import type { Logger } from "@smithy/types";

/**
 * @public
 *
 * The capabilities the WASI providers need from the runtime. Inside a
 * WebAssembly component use `wasiHost` from `@aws-sdk/credential-provider-wasi/wasi`,
 * which is backed by `wasi:cli/environment` and `wasi:filesystem`. Other
 * runtimes (or tests) can supply their own implementation.
 */
export interface WasiHost {
  /**
   * Returns the component's environment. Called on every provider invocation,
   * never at module evaluation time (component snapshots are taken at build time).
   */
  getEnvironment(): Record<string, string | undefined>;
  /**
   * Reads a small UTF-8 file addressed by an absolute guest path.
   *
   * @throws when the file cannot be read.
   */
  readTextFile(absolutePath: string): string | Promise<string>;
}

/**
 * @public
 */
export interface WasiProviderInit {
  /**
   * Runtime adapter used to read the environment and files.
   */
  host: WasiHost;
  logger?: Logger;
}
