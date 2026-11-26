import { CredentialsProviderError } from "@smithy/core/config";
import type { Logger } from "@smithy/types";

/**
 * @internal
 */
export const nonEmpty = (value: string | undefined): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * @internal
 *
 * @throws CredentialsProviderError (not retryable by the chain) when `raw` is not a valid date.
 */
export const parseExpiration = (raw: string | undefined, what: string, logger?: Logger): Date | undefined => {
  if (!raw) {
    return undefined;
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new CredentialsProviderError(`Invalid ${what}: ${raw}`, {
      logger,
      tryNextLink: false,
    });
  }
  return date;
};

/**
 * @internal
 */
export const describeError = (err: unknown): string => {
  if (err && typeof err === "object") {
    const { message, payload } = err as { message?: string; payload?: unknown };
    if (payload !== undefined) {
      return `${message ?? "error"} (${JSON.stringify(payload)})`;
    }
    if (message) {
      return message;
    }
  }
  return String(err);
};

/**
 * @internal
 */
export const notConfigured = (message: string, logger?: Logger): CredentialsProviderError =>
  new CredentialsProviderError(message, { logger, tryNextLink: true });

/**
 * @internal
 */
export const fatal = (message: string, logger?: Logger): CredentialsProviderError =>
  new CredentialsProviderError(message, { logger, tryNextLink: false });
