import { ProviderError } from "@smithy/core/config";
import type { Provider } from "@smithy/types";

import { nonEmpty } from "./util";
import type { WasiProviderInit } from "./WasiHost";

/**
 * @public
 */
export const ENV_REGION = "AWS_REGION";
/**
 * @public
 */
export const ENV_DEFAULT_REGION = "AWS_DEFAULT_REGION";

/**
 * @public
 *
 * Region provider reading `AWS_REGION`, then `AWS_DEFAULT_REGION`, from the
 * component environment on every call.
 *
 * @throws ProviderError "Region is missing" when neither is set.
 */
export const fromWasiRegion =
  (init: WasiProviderInit): Provider<string> =>
  async () => {
    const env = init.host.getEnvironment();
    const region = nonEmpty(env[ENV_REGION]) ?? nonEmpty(env[ENV_DEFAULT_REGION]);
    if (!region) {
      throw new ProviderError(
        `Region is missing: set ${ENV_REGION} (or ${ENV_DEFAULT_REGION}) in the component environment, or pass \`region\` to the client.`,
        { logger: init.logger, tryNextLink: false }
      );
    }
    return region;
  };
