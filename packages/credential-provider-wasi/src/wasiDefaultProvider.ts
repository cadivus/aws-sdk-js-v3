import type {
  AwsCredentialIdentity,
  AwsIdentityProperties,
  RuntimeConfigAwsCredentialIdentityProvider,
} from "@aws-sdk/types";
import { CredentialsProviderError } from "@smithy/core/config";

import { type FromWasiContainerMetadataInit, fromWasiContainerMetadata } from "./fromWasiContainerMetadata";
import { fromWasiEnv } from "./fromWasiEnv";
import { type FromWasiInstanceMetadataInit, fromWasiInstanceMetadata } from "./fromWasiInstanceMetadata";
import { type FromWasiWebIdentityInit, fromWasiWebIdentity } from "./fromWasiWebIdentity";

/**
 * @public
 */
export interface WasiDefaultProviderInit
  extends FromWasiContainerMetadataInit, FromWasiInstanceMetadataInit, FromWasiWebIdentityInit {
  /**
   * Providers tried after the built-in ones, e.g. one backed by a host import that
   * runs the host SDK's own default chain (profiles, SSO, credential_process).
   */
  extraProviders?: RuntimeConfigAwsCredentialIdentityProvider[];
  /**
   * Credentials are refreshed this long before they expire. Default 5 minutes.
   */
  refreshWindowMs?: number;
}

/**
 * @public
 */
export type WasiCredentialProvider = (
  options?: AwsIdentityProperties & { forceRefresh?: boolean }
) => Promise<AwsCredentialIdentity>;

const DEFAULT_REFRESH_WINDOW_MS = 5 * 60 * 1000;

const PROVIDER_NAMES = ["wasi env", "web identity", "container endpoint", "IMDS (opt-in)"];

const isExpired = (credentials: AwsCredentialIdentity, windowMs = 0): boolean =>
  credentials.expiration !== undefined && credentials.expiration.getTime() - Date.now() < windowMs;

/**
 * @public
 *
 * The default credential chain for WebAssembly components, in the order of the
 * Node.js default chain minus the file-based sources (shared config files, SSO,
 * credential_process):
 *
 * 1. environment variables ({@link fromWasiEnv}),
 * 2. web identity token file ({@link fromWasiWebIdentity}),
 * 3. container endpoint, ECS / EKS Pod Identity ({@link fromWasiContainerMetadata}),
 * 4. EC2 IMDSv2, opt-in ({@link fromWasiInstanceMetadata}),
 * 5. `extraProviders`.
 *
 * A provider that is not configured passes to the next one; a configured provider
 * that fails stops the chain with its error. The result is memoized and refreshed
 * `refreshWindowMs` before expiration; if that refresh fails while the cached
 * credentials are still valid, they keep being returned. Pass one instance to
 * every client so credentials are fetched once:
 *
 * ```js
 * const credentials = wasiDefaultProvider();
 * const s3 = new S3Client({ credentials, region: fromWasiRegion() });
 * ```
 */
export const wasiDefaultProvider = (init: WasiDefaultProviderInit): WasiCredentialProvider => {
  const refreshWindowMs = init.refreshWindowMs ?? DEFAULT_REFRESH_WINDOW_MS;
  const extra = init.extraProviders ?? [];
  const tried = [...PROVIDER_NAMES, ...(extra.length > 0 ? [`${extra.length} extra provider(s)`] : [])].join(", ");
  const providers = [
    fromWasiEnv(init),
    fromWasiWebIdentity(init),
    fromWasiContainerMetadata(init),
    fromWasiInstanceMetadata(init),
    ...extra,
  ];

  const resolve = async (options?: AwsIdentityProperties): Promise<AwsCredentialIdentity> => {
    for (const provider of providers) {
      try {
        return await provider(options);
      } catch (err) {
        if (!err?.tryNextLink) {
          throw err;
        }
      }
    }
    throw new CredentialsProviderError(`Could not load credentials from any providers (tried: ${tried}).`, {
      logger: init.logger,
      tryNextLink: false,
    });
  };

  let credentials: AwsCredentialIdentity | undefined;
  let pending: Promise<AwsCredentialIdentity> | undefined;
  return async (options) => {
    if (credentials && !options?.forceRefresh && !isExpired(credentials, refreshWindowMs)) {
      return credentials;
    }
    pending ??= resolve(options)
      .then((resolved) => (credentials = resolved))
      .finally(() => {
        pending = undefined;
      });
    try {
      return await pending;
    } catch (err) {
      if (credentials && !options?.forceRefresh && !isExpired(credentials)) {
        init.logger?.warn(`@aws-sdk/credential-provider-wasi - refresh failed, using cached credentials: ${err}`);
        return credentials;
      }
      throw err;
    }
  };
};
