import { afterEach, describe, expect, test as it } from "vitest";

import { fromWasiEnv } from "./fromWasiEnv";
import { NodeTestHost } from "./testUtils.fixture";

describe(fromWasiEnv.name, () => {
  let host: NodeTestHost;
  afterEach(() => host?.dispose());

  it("returns the full credential set with feature attribution", async () => {
    host = new NodeTestHost({
      AWS_ACCESS_KEY_ID: "AKIDENV",
      AWS_SECRET_ACCESS_KEY: "env-secret",
      AWS_SESSION_TOKEN: "env-session",
      AWS_CREDENTIAL_EXPIRATION: "2030-01-01T00:00:00Z",
      AWS_CREDENTIAL_SCOPE: "us-east-1",
      AWS_ACCOUNT_ID: "123456789012",
    });
    const credentials = await fromWasiEnv({ host })();
    expect(credentials).toEqual({
      accessKeyId: "AKIDENV",
      secretAccessKey: "env-secret",
      sessionToken: "env-session",
      expiration: new Date("2030-01-01T00:00:00Z"),
      credentialScope: "us-east-1",
      accountId: "123456789012",
      $source: { CREDENTIALS_ENV_VARS: "g" },
    });
  });

  it("omits optional fields that are absent or empty", async () => {
    host = new NodeTestHost({
      AWS_ACCESS_KEY_ID: "AKID",
      AWS_SECRET_ACCESS_KEY: "s",
      AWS_SESSION_TOKEN: "",
    });
    const credentials = await fromWasiEnv({ host })();
    expect(credentials).toEqual({
      accessKeyId: "AKID",
      secretAccessKey: "s",
      $source: { CREDENTIALS_ENV_VARS: "g" },
    });
  });

  it.each([
    [{}],
    [{ AWS_ACCESS_KEY_ID: "AKID" }],
    [{ AWS_SECRET_ACCESS_KEY: "s" }],
    [{ AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "s" }],
  ])("passes to the next provider when the key pair is incomplete: %j", async (env) => {
    host = new NodeTestHost(env);
    await expect(fromWasiEnv({ host })()).rejects.toMatchObject({
      name: "CredentialsProviderError",
      tryNextLink: true,
      message: "Unable to find environment variable credentials.",
    });
  });

  it("fails the chain on an invalid AWS_CREDENTIAL_EXPIRATION", async () => {
    host = new NodeTestHost({
      AWS_ACCESS_KEY_ID: "AKID",
      AWS_SECRET_ACCESS_KEY: "s",
      AWS_CREDENTIAL_EXPIRATION: "tomorrow",
    });
    await expect(fromWasiEnv({ host })()).rejects.toMatchObject({
      tryNextLink: false,
      message: "Invalid AWS_CREDENTIAL_EXPIRATION: tomorrow",
    });
  });

  it("reads the environment on every call, never at creation", async () => {
    host = new NodeTestHost({});
    const provider = fromWasiEnv({ host });
    expect(host.envReads).toBe(0);
    await expect(provider()).rejects.toThrow();
    host.env = { AWS_ACCESS_KEY_ID: "LATER", AWS_SECRET_ACCESS_KEY: "s" };
    await expect(provider()).resolves.toMatchObject({ accessKeyId: "LATER" });
    expect(host.envReads).toBe(2);
  });
});
