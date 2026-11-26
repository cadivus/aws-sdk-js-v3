# @aws-sdk/credential-provider-wasi

> **Prototype.** Not published. Proposed upstream as an RFC; the API may change.

AWS credential and region providers for code running inside a **WebAssembly
component** (WASI 0.2), for example a JavaScript component built with
[ComponentizeJS](https://github.com/bytecodealliance/ComponentizeJS) /
[jco](https://github.com/bytecodealliance/jco) on StarlingMonkey.

## Why

A component bundle uses the SDK's **browser** runtime config, because
StarlingMonkey has `fetch` and `crypto.subtle` but no `process`, `fs` or Node
`http`. The browser defaults are `Credential is missing` and
`Region is missing`, and `@aws-sdk/credential-provider-node` cannot run there.

This package provides the WASI equivalent of the Node default chain and a
region provider, which you pass to clients explicitly.

## Usage

```js
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { S3Client } from "@aws-sdk/client-s3";
import { fromWasiRegion, wasiDefaultProvider } from "@aws-sdk/credential-provider-wasi/wasi";

export const run = async () => {
  // One provider instance per component instance, shared by every client.
  const config = { credentials: wasiDefaultProvider(), region: fromWasiRegion() };
  const sts = new STSClient(config);
  const s3 = new S3Client(config);
  return JSON.stringify(await sts.send(new GetCallerIdentityCommand({})));
};
```

Options:

```js
wasiDefaultProvider({
  refreshWindowMs: 5 * 60_000,
  enabled: true, // opt in to EC2 IMDSv2 (fromWasiInstanceMetadata)
  extraProviders: [fromMyHostImport], // e.g. a host-provided credential import
});
```

Creating the providers does **not** read the environment; they read it when
called. Creating them at module top level is therefore safe (ComponentizeJS
snapshots top-level state at build time with Wizer).

The component's world must import `wasi:cli/environment@0.2.12` and
`wasi:filesystem/preopens@0.2.12` (jco's built-in WASI WIT). Mark `wasi:*` as
external when bundling.

## Default chain

Order, first match wins:

| #   | Provider                    | Source                                                                                                                                                | Notes                                                                                                                                           |
| --- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `fromWasiEnv`               | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_CREDENTIAL_EXPIRATION`, `AWS_CREDENTIAL_SCOPE`, `AWS_ACCOUNT_ID`              | Lambda execution role, exported dev creds. Invalid expiration is an error.                                                                      |
| 2   | `fromWasiWebIdentity`       | `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN`, `AWS_ROLE_SESSION_NAME`                                                                                | EKS IRSA. Token file read through `wasi:filesystem` (needs a preopen), then STS `AssumeRoleWithWebIdentity` in the calling client's region.     |
| 3   | `fromWasiContainerMetadata` | `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` (→ `http://169.254.170.2`), `AWS_CONTAINER_CREDENTIALS_FULL_URI`, `AWS_CONTAINER_AUTHORIZATION_TOKEN[_FILE]` | ECS / Fargate task role, EKS Pod Identity. Uses `@aws-sdk/credential-provider-http`.                                                            |
| 4   | `fromWasiInstanceMetadata`  | EC2 IMDSv2 over `fetch`                                                                                                                               | **Opt-in**: `AWS_WASI_ENABLE_IMDS=true`, `AWS_EC2_METADATA_SERVICE_ENDPOINT`, or `enabled: true`. `AWS_EC2_METADATA_DISABLED=true` always wins. |
| 5   | `extraProviders`            | anything                                                                                                                                              | e.g. a host import backed by the host SDK's own chain (profiles, SSO, `credential_process`).                                                    |

Once a provider is configured (its variables are set), its failures stop the
chain instead of silently falling through, like the Node chain. If nothing is
configured the error lists every provider that was tried.

The result is memoized: concurrent and repeated calls share one fetch. It is
refreshed `refreshWindowMs` (default 5 min) before `expiration`; if that refresh
fails while the cached credentials are still valid, they keep being returned.

Region: `fromWasiRegion` reads `AWS_REGION`, then `AWS_DEFAULT_REGION`.

Not supported inside the guest (use `extraProviders`): shared config /
credentials files, SSO, `credential_process`.

## Testing without Wasm

All `wasi:` specifiers are isolated in `./wasi`. The main entry takes a
`WasiHost`:

```ts
interface WasiHost {
  getEnvironment(): Record<string, string | undefined>;
  readTextFile(absolutePath: string): string | Promise<string>;
}
```

`createWasiHost(environmentImport, preopensImport)` builds one from the raw WASI
bindings; tests pass plain objects and run in Node (`yarn test`).
