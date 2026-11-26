import { afterEach, describe, expect, test as it } from "vitest";

import { fromWasiInstanceMetadata } from "./fromWasiInstanceMetadata";
import { isoIn, json, NodeTestHost, startServer, type TestServer } from "./testUtils.fixture";

const TOKEN = "imds-session-token";

const imdsHandler =
  (options: { profile?: string; expiration?: string; hang?: boolean } = {}) =>
  (req: { method: string; url: string; headers: Record<string, unknown> }, res: any) => {
    if (options.hang) {
      return;
    }
    if (req.method === "PUT" && req.url === "/latest/api/token") {
      if (!req.headers["x-aws-ec2-metadata-token-ttl-seconds"]) {
        return json(res, 400, {});
      }
      res.end(TOKEN);
      return;
    }
    if (req.headers["x-aws-ec2-metadata-token"] !== TOKEN) {
      return json(res, 401, {});
    }
    if (req.url === "/latest/meta-data/iam/security-credentials/") {
      res.end(options.profile ?? "instance-role\n");
      return;
    }
    if (req.url === `/latest/meta-data/iam/security-credentials/${(options.profile ?? "instance-role").trim()}`) {
      return json(res, 200, {
        Code: "Success",
        AccessKeyId: "AKIDIMDS",
        SecretAccessKey: "imds-secret",
        Token: "imds-session",
        Expiration: options.expiration ?? isoIn(6 * 3600_000),
      });
    }
    json(res, 404, {});
  };

describe(fromWasiInstanceMetadata.name, () => {
  let host: NodeTestHost;
  let server: TestServer | undefined;
  afterEach(async () => {
    host?.dispose();
    await server?.close();
    server = undefined;
  });

  it("is disabled unless opted in", async () => {
    host = new NodeTestHost();
    await expect(fromWasiInstanceMetadata({ host })()).rejects.toMatchObject({
      tryNextLink: true,
      message: "IMDS is not enabled for this component.",
    });
  });

  it("performs the IMDSv2 flow when an endpoint is configured", async () => {
    const expiration = isoIn(3 * 3600_000);
    server = await startServer(imdsHandler({ expiration }));
    host = new NodeTestHost({
      AWS_EC2_METADATA_SERVICE_ENDPOINT: `${server.url}/`,
    });
    const credentials = await fromWasiInstanceMetadata({ host })();
    expect(credentials).toEqual({
      accessKeyId: "AKIDIMDS",
      secretAccessKey: "imds-secret",
      sessionToken: "imds-session",
      expiration: new Date(expiration),
      $source: { CREDENTIALS_IMDS: "0" },
    });
    expect(server.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "PUT /latest/api/token",
      "GET /latest/meta-data/iam/security-credentials/",
      "GET /latest/meta-data/iam/security-credentials/instance-role",
    ]);
    expect(server.requests[0].headers["x-aws-ec2-metadata-token-ttl-seconds"]).toBe("21600");
  });

  it("AWS_EC2_METADATA_DISABLED=true wins over every opt-in", async () => {
    host = new NodeTestHost({
      AWS_EC2_METADATA_SERVICE_ENDPOINT: "http://127.0.0.1:1",
      AWS_WASI_ENABLE_IMDS: "true",
      AWS_EC2_METADATA_DISABLED: "true",
    });
    await expect(fromWasiInstanceMetadata({ host, enabled: true })()).rejects.toMatchObject({ tryNextLink: true });
  });

  it("can be enabled through AWS_WASI_ENABLE_IMDS or init.enabled; init.endpoint alone does not enable it", async () => {
    server = await startServer(imdsHandler());
    host = new NodeTestHost();
    await expect(fromWasiInstanceMetadata({ host, endpoint: server.url })()).rejects.toMatchObject({
      tryNextLink: true,
    });
    host.env = { AWS_WASI_ENABLE_IMDS: "true" };
    await expect(fromWasiInstanceMetadata({ host, endpoint: server.url })()).resolves.toMatchObject({
      accessKeyId: "AKIDIMDS",
    });
    host.env = {};
    await expect(fromWasiInstanceMetadata({ host, endpoint: server.url, enabled: true })()).resolves.toMatchObject({
      accessKeyId: "AKIDIMDS",
    });
  });

  it("the environment endpoint wins over init.endpoint", async () => {
    server = await startServer(imdsHandler());
    host = new NodeTestHost({ AWS_EC2_METADATA_SERVICE_ENDPOINT: server.url });
    await expect(fromWasiInstanceMetadata({ host, endpoint: "http://127.0.0.1:1" })()).resolves.toMatchObject({
      accessKeyId: "AKIDIMDS",
    });
  });

  it("fails the chain when no instance profile is attached", async () => {
    server = await startServer(imdsHandler({ profile: "\n" }));
    host = new NodeTestHost({ AWS_EC2_METADATA_SERVICE_ENDPOINT: server.url });
    await expect(fromWasiInstanceMetadata({ host })()).rejects.toMatchObject({
      tryNextLink: false,
      message: expect.stringContaining("no instance profile is attached"),
    });
  });

  it("fails the chain on a non-2xx response", async () => {
    server = await startServer((_req, res) => json(res, 403, {}));
    host = new NodeTestHost({ AWS_EC2_METADATA_SERVICE_ENDPOINT: server.url });
    await expect(fromWasiInstanceMetadata({ host })()).rejects.toMatchObject({
      tryNextLink: false,
      message: expect.stringContaining("PUT " + server.url + "/latest/api/token returned HTTP 403"),
    });
  });

  it("fails the chain with a timeout message when IMDS hangs", async () => {
    server = await startServer(imdsHandler({ hang: true }));
    host = new NodeTestHost({ AWS_EC2_METADATA_SERVICE_ENDPOINT: server.url });
    await expect(fromWasiInstanceMetadata({ host, timeout: 100 })()).rejects.toMatchObject({
      tryNextLink: false,
      message: expect.stringContaining("timed out after 100 ms"),
    });
  });
});
