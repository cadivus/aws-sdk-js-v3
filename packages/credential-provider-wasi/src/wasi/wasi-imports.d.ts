declare module "wasi:cli/environment@0.2.12" {
  export function getEnvironment(): Array<[string, string]>;
}

declare module "wasi:filesystem/preopens@0.2.12" {
  import type { WasiDescriptor } from "../createWasiHost";
  export function getDirectories(): Array<[WasiDescriptor, string]>;
}
