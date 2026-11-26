import { setCredentialFeature } from "@aws-sdk/core/client";
import { fromHttp } from "@aws-sdk/credential-provider-http";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";

import { describeError, fatal, nonEmpty, notConfigured } from "./util";
import type { WasiProviderInit } from "./WasiHost";

/**
 * @public
 */
export const ENV_CONTAINER_RELATIVE_URI = "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI";
/**
 * @public
 */
export const ENV_CONTAINER_FULL_URI = "AWS_CONTAINER_CREDENTIALS_FULL_URI";
/**
 * @public
 */
export const ENV_CONTAINER_AUTHORIZATION_TOKEN = "AWS_CONTAINER_AUTHORIZATION_TOKEN";
/**
 * @public
 */
export const ENV_CONTAINER_AUTHORIZATION_TOKEN_FILE = "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE";

const ECS_CONTAINER_HOST = "http://169.254.170.2";

/**
 * @public
 */
export interface FromWasiContainerMetadataInit extends WasiProviderInit {
  /**
   * Per-attempt timeout in milliseconds. Default 1000.
   */
  timeout?: number;
  /**
   * Retries after the first attempt. Default 3.
   */
  maxRetries?: number;
}

/**
 * @public
 *
 * ECS / Fargate and EKS Pod Identity container credentials, following the same
 * environment contract as `fromHttp` from `@aws-sdk/credential-provider-http`:
 * `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` (preferred, against 169.254.170.2) or
 * `AWS_CONTAINER_CREDENTIALS_FULL_URI`, plus `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`
 * (preferred) or `AWS_CONTAINER_AUTHORIZATION_TOKEN`. The request, URL allow-list
 * and response validation are delegated to `fromHttp` (its fetch-based variant in
 * browser-condition bundles).
 *
 * Once an endpoint is configured, every failure is fatal for the chain, so a
 * broken container endpoint is never masked by a later provider.
 */
export const fromWasiContainerMetadata =
  (init: FromWasiContainerMetadataInit): AwsCredentialIdentityProvider =>
  async () => {
    init.logger?.debug("@aws-sdk/credential-provider-wasi - fromWasiContainerMetadata");
    const env = init.host.getEnvironment();
    const relative = nonEmpty(env[ENV_CONTAINER_RELATIVE_URI]);
    const full = nonEmpty(env[ENV_CONTAINER_FULL_URI]);
    if (!relative && !full) {
      throw notConfigured("No container credentials endpoint configured.", init.logger);
    }
    const credentialsFullUri = relative ? `${ECS_CONTAINER_HOST}${relative}` : full!;

    let authorizationToken = nonEmpty(env[ENV_CONTAINER_AUTHORIZATION_TOKEN]);
    const tokenFile = nonEmpty(env[ENV_CONTAINER_AUTHORIZATION_TOKEN_FILE]);
    if (tokenFile) {
      try {
        authorizationToken = (await init.host.readTextFile(tokenFile)).trim();
      } catch (err) {
        throw fatal(
          `Failed to read ${ENV_CONTAINER_AUTHORIZATION_TOKEN_FILE} ${tokenFile}: ${describeError(err)}`,
          init.logger
        );
      }
    }

    try {
      const credentials = await fromHttp({
        credentialsFullUri,
        authorizationToken,
        awsContainerCredentialsFullUri: credentialsFullUri,
        awsContainerAuthorizationToken: authorizationToken,
        timeout: init.timeout ?? 1000,
        maxRetries: init.maxRetries ?? 3,
        logger: init.logger,
      })();
      return setCredentialFeature(credentials, "CREDENTIALS_HTTP", "z");
    } catch (err) {
      throw fatal(`Container credentials endpoint ${credentialsFullUri} failed: ${describeError(err)}`, init.logger);
    }
  };
