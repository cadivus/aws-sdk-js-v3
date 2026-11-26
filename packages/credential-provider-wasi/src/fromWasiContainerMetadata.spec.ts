import { afterEach, describe, expect, test as it } from "vitest";

import { fromWasiContainerMetadata } from "./fromWasiContainerMetadata";
import { isoIn, json, NodeTestHost, startServer, type TestServer } from "./testUtils.fixture";

const ECS_BODY = (expiration: string) => ({
  AccessKeyId: "AKIDECS",
  SecretAccessKey: "ecs-secret",
  Token: "ecs-session",
  Expiration: expiration,
  AccountId: "123456789012",
});

describe(fromWasiContainerMetadata.name, () => {
  let host: NodeTestHost;
  let server: TestServer | undefined;
  afterEach(async () => {
    host?.dispose();
    await server?.close();
    server = undefined;
  });

  it("passes to the next provider when no endpoint is configured", async () => {
    host = new NodeTestHost({ AWS_CONTAINER_AUTHORIZATION_TOKEN: "t" });
    await expect(fromWasiContainerMetadata({ host })()).rejects.toMatchObject({
      tryNextLink: true,
      message: "No container credentials endpoint configured.",
    });
  });

  it("fetches FULL_URI credentials with the authorization token", async () => {
    const expiration = isoIn(6 * 3600_000);
    server = await startServer((req, res) =>
      req.headers.authorization === "static-token" ? json(res, 200, ECS_BODY(expiration)) : json(res, 401, {})
    );
    host = new NodeTestHost({
      AWS_CONTAINER_CREDENTIALS_FULL_URI: `${server.url}/v1/credentials`,
      AWS_CONTAINER_AUTHORIZATION_TOKEN: "static-token",
    });
    const credentials = await fromWasiContainerMetadata({ host })();
    expect(credentials).toMatchObject({
      accessKeyId: "AKIDECS",
      secretAccessKey: "ecs-secret",
      sessionToken: "ecs-session",
      expiration: new Date(expiration),
      $source: { CREDENTIALS_HTTP: "z" },
    });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: "GET",
      url: "/v1/credentials",
    });
  });

  it("prefers the token file over the token variable (EKS Pod Identity)", async () => {
    server = await startServer((req, res) =>
      req.headers.authorization === "pod-identity-token"
        ? json(res, 200, ECS_BODY(isoIn(3600_000)))
        : json(res, 401, {})
    );
    host = new NodeTestHost();
    const tokenFile = host.writeFile(
      "/var/run/secrets/pods.eks.amazonaws.com/serviceaccount/eks-pod-identity-token",
      "pod-identity-token\n"
    );
    host.env = {
      AWS_CONTAINER_CREDENTIALS_FULL_URI: `${server.url}/v1/credentials`,
      AWS_CONTAINER_AUTHORIZATION_TOKEN: "ignored",
      AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: tokenFile,
    };
    await expect(fromWasiContainerMetadata({ host })()).resolves.toMatchObject({
      accessKeyId: "AKIDECS",
    });
    expect(server.requests[0].headers.authorization).toBe("pod-identity-token");
  });

  it("fails the chain when the token file cannot be read", async () => {
    host = new NodeTestHost({
      AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://127.0.0.1:1/creds",
      AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: "/does/not/exist",
    });
    await expect(fromWasiContainerMetadata({ host })()).rejects.toMatchObject({
      tryNextLink: false,
      message: expect.stringContaining("Failed to read AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE /does/not/exist"),
    });
  });

  it("fails the chain when the endpoint rejects the request", async () => {
    server = await startServer((_req, res) => json(res, 401, { message: "bad token" }));
    host = new NodeTestHost({
      AWS_CONTAINER_CREDENTIALS_FULL_URI: `${server.url}/creds`,
    });
    await expect(fromWasiContainerMetadata({ host, maxRetries: 1, timeout: 500 })()).rejects.toMatchObject({
      tryNextLink: false,
      message: expect.stringContaining(`Container credentials endpoint ${server.url}/creds failed`),
    });
    expect(server.requests).toHaveLength(2);
  });

  it("retries transient failures", async () => {
    let calls = 0;
    server = await startServer((_req, res) =>
      ++calls === 1 ? json(res, 500, {}) : json(res, 200, ECS_BODY(isoIn(3600_000)))
    );
    host = new NodeTestHost({
      AWS_CONTAINER_CREDENTIALS_FULL_URI: `${server.url}/creds`,
    });
    await expect(fromWasiContainerMetadata({ host, maxRetries: 2 })()).resolves.toMatchObject({
      accessKeyId: "AKIDECS",
    });
    expect(calls).toBe(2);
  });

  it("rejects FULL_URI hosts outside the allow-list", async () => {
    host = new NodeTestHost({
      AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://example.com/creds",
    });
    await expect(fromWasiContainerMetadata({ host, maxRetries: 0 })()).rejects.toMatchObject({
      tryNextLink: false,
      message: expect.stringContaining("http://example.com/creds failed"),
    });
  });

  it("resolves RELATIVE_URI against 169.254.170.2 and prefers it over FULL_URI", async () => {
    host = new NodeTestHost({
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/task-id",
      AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://127.0.0.1:1/unused",
    });
    await expect(fromWasiContainerMetadata({ host, timeout: 50, maxRetries: 0 })()).rejects.toMatchObject({
      tryNextLink: false,
      message: expect.stringContaining(
        "Container credentials endpoint http://169.254.170.2/v2/credentials/task-id failed"
      ),
    });
  });
});
