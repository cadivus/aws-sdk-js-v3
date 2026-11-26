import { setCredentialFeature } from "@aws-sdk/core/client";
import { fromWebToken } from "@aws-sdk/credential-provider-web-identity";
import type { AwsIdentityProperties, RuntimeConfigAwsCredentialIdentityProvider } from "@aws-sdk/types";

import { describeError, fatal, nonEmpty, notConfigured } from "./util";
import type { WasiProviderInit } from "./WasiHost";

/**
 * @public
 */
export const ENV_WEB_IDENTITY_TOKEN_FILE = "AWS_WEB_IDENTITY_TOKEN_FILE";
/**
 * @public
 */
export const ENV_ROLE_ARN = "AWS_ROLE_ARN";
/**
 * @public
 */
export const ENV_ROLE_SESSION_NAME = "AWS_ROLE_SESSION_NAME";

/**
 * @public
 */
export interface FromWasiWebIdentityInit extends WasiProviderInit {
  /**
   * Extra configuration for the STS client that performs AssumeRoleWithWebIdentity.
   */
  clientConfig?: any;
}

/**
 * @public
 *
 * IRSA / web identity federation, mirroring `fromTokenFile`: reads the token file
 * named by `AWS_WEB_IDENTITY_TOKEN_FILE` through the {@link WasiHost} and calls
 * STS AssumeRoleWithWebIdentity for `AWS_ROLE_ARN` (optional
 * `AWS_ROLE_SESSION_NAME`) via `fromWebToken`.
 *
 * Once configured, a token read or STS failure is fatal for the chain.
 */
export const fromWasiWebIdentity =
  (init: FromWasiWebIdentityInit): RuntimeConfigAwsCredentialIdentityProvider =>
  async (awsIdentityProperties?: AwsIdentityProperties) => {
    init.logger?.debug("@aws-sdk/credential-provider-wasi - fromWasiWebIdentity");
    const env = init.host.getEnvironment();
    const tokenFile = nonEmpty(env[ENV_WEB_IDENTITY_TOKEN_FILE]);
    const roleArn = nonEmpty(env[ENV_ROLE_ARN]);
    if (!tokenFile || !roleArn) {
      throw notConfigured("Web identity is not configured.", init.logger);
    }

    let webIdentityToken: string;
    try {
      webIdentityToken = (await init.host.readTextFile(tokenFile)).trim();
    } catch (err) {
      throw fatal(`Failed to read ${ENV_WEB_IDENTITY_TOKEN_FILE} ${tokenFile}: ${describeError(err)}`, init.logger);
    }
    if (!webIdentityToken) {
      throw fatal(`${ENV_WEB_IDENTITY_TOKEN_FILE} ${tokenFile} is empty.`, init.logger);
    }

    try {
      const credentials = await fromWebToken({
        roleArn,
        roleSessionName: nonEmpty(env[ENV_ROLE_SESSION_NAME]),
        webIdentityToken,
        logger: init.logger,
        clientConfig: init.clientConfig,
      })(awsIdentityProperties);
      return setCredentialFeature(credentials, "CREDENTIALS_ENV_VARS_STS_WEB_ID_TOKEN", "h");
    } catch (err) {
      throw fatal(`AssumeRoleWithWebIdentity for ${roleArn} failed: ${describeError(err)}`, init.logger);
    }
  };
