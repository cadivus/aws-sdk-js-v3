import type { WasiHost } from "./WasiHost";

/**
 * @public
 *
 * Structural type of the `wasi:cli/environment` 0.2 import.
 */
export interface WasiEnvironmentImport {
  getEnvironment(): Array<[string, string]>;
}

/**
 * @public
 *
 * The subset of a `wasi:filesystem/types` 0.2 `descriptor` resource used here.
 */
export interface WasiDescriptor {
  openAt(
    pathFlags: { symlinkFollow?: boolean },
    path: string,
    openFlags: Record<string, boolean>,
    flags: { read?: boolean }
  ): WasiDescriptor;
  read(length: bigint, offset: bigint): [Uint8Array, boolean];
}

/**
 * @public
 *
 * Structural type of the `wasi:filesystem/preopens` 0.2 import.
 */
export interface WasiPreopensImport {
  getDirectories(): Array<[WasiDescriptor, string]>;
}

/**
 * @public
 */
export interface CreateWasiHostOptions {
  /**
   * Files larger than this are rejected. Default 64 KiB (tokens are a few KiB).
   */
  maxFileBytes?: number;
}

const DEFAULT_MAX_FILE_BYTES = 64 * 1024;
const READ_CHUNK = 4096n;

const dispose = (resource: unknown): void => {
  const symbol = (Symbol as { dispose?: symbol }).dispose;
  const fn = symbol && (resource as Record<symbol, unknown>)?.[symbol];
  if (typeof fn === "function") {
    fn.call(resource);
  }
};

/**
 * @public
 *
 * Builds a {@link WasiHost} from the WASI 0.2 `environment` and `preopens`
 * imports. Absolute file paths are resolved against the longest matching
 * preopened directory; `..` segments are rejected.
 */
export const createWasiHost = (
  environment: WasiEnvironmentImport,
  preopens: WasiPreopensImport,
  options: CreateWasiHostOptions = {}
): WasiHost => {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  return {
    getEnvironment() {
      const env: Record<string, string> = Object.create(null);
      for (const [key, value] of environment.getEnvironment()) {
        env[key] = value;
      }
      return env;
    },
    readTextFile(absolutePath: string) {
      if (!absolutePath.startsWith("/")) {
        throw new Error(`Expected an absolute path, got: ${absolutePath}`);
      }
      if (absolutePath.split("/").includes("..")) {
        throw new Error(`Path must not contain '..' segments: ${absolutePath}`);
      }
      let best: { descriptor: WasiDescriptor; base: string } | undefined;
      for (const [descriptor, preopenPath] of preopens.getDirectories()) {
        const base = preopenPath === "/" ? "/" : preopenPath.replace(/\/+$/, "") + "/";
        if (absolutePath.startsWith(base) && (!best || base.length > best.base.length)) {
          best = { descriptor, base };
        }
      }
      if (!best) {
        throw new Error(`No preopened directory grants access to ${absolutePath}`);
      }
      const relative = absolutePath.slice(best.base.length);
      const file = best.descriptor.openAt({ symlinkFollow: true }, relative, {}, { read: true });
      try {
        const chunks: Uint8Array[] = [];
        let total = 0;
        let offset = 0n;
        for (;;) {
          const [bytes, eof] = file.read(READ_CHUNK, offset);
          total += bytes.length;
          if (total > maxFileBytes) {
            throw new Error(`${absolutePath} exceeds ${maxFileBytes} bytes`);
          }
          chunks.push(bytes);
          offset += BigInt(bytes.length);
          if (eof || bytes.length === 0) {
            break;
          }
        }
        const merged = new Uint8Array(total);
        let position = 0;
        for (const chunk of chunks) {
          merged.set(chunk, position);
          position += chunk.length;
        }
        return new TextDecoder().decode(merged);
      } finally {
        dispose(file);
      }
    },
  };
};
