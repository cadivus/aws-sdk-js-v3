import { setCredentialFeature } from "@aws-sdk/core/client";
import type { AttributedAwsCredentialIdentity, AwsCredentialIdentityProvider } from "@aws-sdk/types";

import { nonEmpty, notConfigured, parseExpiration } from "./util";
import type { WasiProviderInit } from "./WasiHost";

/**
 * @public
 */
export const ENV_ACCESS_KEY_ID = "AWS_ACCESS_KEY_ID";
/**
 * @public
 */
export const ENV_SECRET_ACCESS_KEY = "AWS_SECRET_ACCESS_KEY";
/**
 * @public
 */
export const ENV_SESSION_TOKEN = "AWS_SESSION_TOKEN";
/**
 * @public
 */
export const ENV_CREDENTIAL_EXPIRATION = "AWS_CREDENTIAL_EXPIRATION";
/**
 * @public
 */
export const ENV_CREDENTIAL_SCOPE = "AWS_CREDENTIAL_SCOPE";
/**
 * @public
 */
export const ENV_ACCOUNT_ID = "AWS_ACCOUNT_ID";

/**
 * @public
 *
 * Equivalent of `fromEnv` from `@aws-sdk/credential-provider-env`, reading the
 * component environment through the {@link WasiHost}. This covers AWS Lambda
 * (execution role credentials are exported as environment variables).
 *
 * Rejects with a chain-continuable error when the key pair is absent, and with a
 * fatal error when `AWS_CREDENTIAL_EXPIRATION` is not a valid date.
 */
export const fromWasiEnv =
  (init: WasiProviderInit): AwsCredentialIdentityProvider =>
  async () => {
    init.logger?.debug("@aws-sdk/credential-provider-wasi - fromWasiEnv");
    const env = init.host.getEnvironment();
    const accessKeyId = nonEmpty(env[ENV_ACCESS_KEY_ID]);
    const secretAccessKey = nonEmpty(env[ENV_SECRET_ACCESS_KEY]);
    if (!accessKeyId || !secretAccessKey) {
      throw notConfigured("Unable to find environment variable credentials.", init.logger);
    }
    const credentials: AttributedAwsCredentialIdentity = {
      accessKeyId,
      secretAccessKey,
      ...(nonEmpty(env[ENV_SESSION_TOKEN]) && {
        sessionToken: env[ENV_SESSION_TOKEN],
      }),
      ...(nonEmpty(env[ENV_CREDENTIAL_EXPIRATION]) && {
        expiration: parseExpiration(env[ENV_CREDENTIAL_EXPIRATION], ENV_CREDENTIAL_EXPIRATION, init.logger),
      }),
      ...(nonEmpty(env[ENV_CREDENTIAL_SCOPE]) && {
        credentialScope: env[ENV_CREDENTIAL_SCOPE],
      }),
      ...(nonEmpty(env[ENV_ACCOUNT_ID]) && { accountId: env[ENV_ACCOUNT_ID] }),
    };
    return setCredentialFeature(credentials, "CREDENTIALS_ENV_VARS", "g");
  };
