import { setCredentialFeature } from "@aws-sdk/core/client";
import type { AttributedAwsCredentialIdentity, AwsCredentialIdentityProvider } from "@aws-sdk/types";

import { describeError, fatal, nonEmpty, notConfigured, parseExpiration } from "./util";
import type { WasiProviderInit } from "./WasiHost";

/**
 * @public
 */
export const ENV_ENABLE_IMDS = "AWS_WASI_ENABLE_IMDS";
/**
 * @public
 */
export const ENV_IMDS_ENDPOINT = "AWS_EC2_METADATA_SERVICE_ENDPOINT";
/**
 * @public
 */
export const ENV_IMDS_DISABLED = "AWS_EC2_METADATA_DISABLED";

const IMDS_DEFAULT_ENDPOINT = "http://169.254.169.254";
const IMDS_TOKEN_TTL_SECONDS = "21600";
const CREDENTIALS_PATH = "/latest/meta-data/iam/security-credentials/";

/**
 * @public
 */
export interface FromWasiInstanceMetadataInit extends WasiProviderInit {
  /**
   * Per-request timeout in milliseconds. Default 1000.
   */
  timeout?: number;
  /**
   * Force-enable the provider regardless of the environment (still subject to
   * `AWS_EC2_METADATA_DISABLED=true`).
   */
  enabled?: boolean;
  /**
   * IMDS endpoint used when `AWS_EC2_METADATA_SERVICE_ENDPOINT` is not set.
   * Default http://169.254.169.254. Setting it does not enable the provider.
   */
  endpoint?: string;
}

const fetchText = async (url: string, init: RequestInit, timeoutMs: number): Promise<string> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`${init.method ?? "GET"} ${url} returned HTTP ${response.status}`);
    }
    return body;
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`${init.method ?? "GET"} ${url} timed out after ${timeoutMs} ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * @public
 *
 * EC2 instance metadata credentials, IMDSv2 only (PUT session token, then GET the
 * role credentials) over `fetch`.
 *
 * Opt-in, because outside EC2 a link-local request can only time out: enabled by
 * `AWS_WASI_ENABLE_IMDS=true`, by setting `AWS_EC2_METADATA_SERVICE_ENDPOINT`, or by
 * `init.enabled`; always disabled by `AWS_EC2_METADATA_DISABLED=true`. Once enabled,
 * every failure is fatal for the chain.
 */
export const fromWasiInstanceMetadata =
  (init: FromWasiInstanceMetadataInit): AwsCredentialIdentityProvider =>
  async () => {
    init.logger?.debug("@aws-sdk/credential-provider-wasi - fromWasiInstanceMetadata");
    const env = init.host.getEnvironment();
    const endpoint = nonEmpty(env[ENV_IMDS_ENDPOINT]);
    const enabled = init.enabled === true || env[ENV_ENABLE_IMDS] === "true" || endpoint !== undefined;
    if (!enabled || env[ENV_IMDS_DISABLED] === "true") {
      throw notConfigured("IMDS is not enabled for this component.", init.logger);
    }
    const base = (endpoint ?? init.endpoint ?? IMDS_DEFAULT_ENDPOINT).replace(/\/+$/, "");
    const timeout = init.timeout ?? 1000;
    try {
      const token = await fetchText(
        `${base}/latest/api/token`,
        {
          method: "PUT",
          headers: {
            "x-aws-ec2-metadata-token-ttl-seconds": IMDS_TOKEN_TTL_SECONDS,
          },
        },
        timeout
      );
      const headers = { "x-aws-ec2-metadata-token": token };
      const profile = (await fetchText(`${base}${CREDENTIALS_PATH}`, { headers }, timeout)).split("\n")[0].trim();
      if (!profile) {
        throw new Error("no instance profile is attached");
      }
      const doc = JSON.parse(await fetchText(`${base}${CREDENTIALS_PATH}${profile}`, { headers }, timeout));
      if (!doc.AccessKeyId || !doc.SecretAccessKey) {
        throw new Error("response has no AccessKeyId/SecretAccessKey");
      }
      const credentials: AttributedAwsCredentialIdentity = {
        accessKeyId: doc.AccessKeyId,
        secretAccessKey: doc.SecretAccessKey,
        ...(doc.Token && { sessionToken: doc.Token }),
        ...(doc.Expiration && {
          expiration: parseExpiration(doc.Expiration, "IMDS Expiration", init.logger),
        }),
        ...(doc.AccountId && { accountId: doc.AccountId }),
      };
      return setCredentialFeature(credentials, "CREDENTIALS_IMDS", "0");
    } catch (err) {
      throw fatal(`IMDS ${base} failed: ${describeError(err)}`, init.logger);
    }
  };
