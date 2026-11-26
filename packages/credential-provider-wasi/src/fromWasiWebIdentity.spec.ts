import { afterEach, describe, expect, test as it } from "vitest";

import { fromWasiWebIdentity } from "./fromWasiWebIdentity";
import { isoIn, NodeTestHost, startServer, stsCredentialsXml, type TestServer } from "./testUtils.fixture";

const TOKEN_FILE = "/var/run/secrets/eks.amazonaws.com/serviceaccount/token";
const ROLE_ARN = "arn:aws:iam::123456789012:role/irsa-role";

describe(fromWasiWebIdentity.name, () => {
  let host: NodeTestHost;
  let server: TestServer | undefined;
  afterEach(async () => {
    host?.dispose();
    await server?.close();
    server = undefined;
  });

  it.each([[{}], [{ AWS_WEB_IDENTITY_TOKEN_FILE: TOKEN_FILE }], [{ AWS_ROLE_ARN: ROLE_ARN }]])(
    "passes to the next provider when not fully configured: %j",
    async (env) => {
      host = new NodeTestHost(env);
      await expect(fromWasiWebIdentity({ host })()).rejects.toMatchObject({
        tryNextLink: true,
        message: "Web identity is not configured.",
      });
    }
  );

  it("fails the chain when the token file cannot be read", async () => {
    host = new NodeTestHost({
      AWS_WEB_IDENTITY_TOKEN_FILE: TOKEN_FILE,
      AWS_ROLE_ARN: ROLE_ARN,
    });
    await expect(fromWasiWebIdentity({ host })()).rejects.toMatchObject({
      tryNextLink: false,
      message: expect.stringContaining(`Failed to read AWS_WEB_IDENTITY_TOKEN_FILE ${TOKEN_FILE}`),
    });
  });

  it("fails the chain when the token file is empty", async () => {
    host = new NodeTestHost({
      AWS_WEB_IDENTITY_TOKEN_FILE: TOKEN_FILE,
      AWS_ROLE_ARN: ROLE_ARN,
    });
    host.writeFile(TOKEN_FILE, "  \n");
    await expect(fromWasiWebIdentity({ host })()).rejects.toMatchObject({
      tryNextLink: false,
      message: `AWS_WEB_IDENTITY_TOKEN_FILE ${TOKEN_FILE} is empty.`,
    });
  });

  it("calls STS AssumeRoleWithWebIdentity with the token, role and session name", async () => {
    const expiration = isoIn(3600_000);
    server = await startServer((req, res) => {
      res.setHeader("content-type", "text/xml");
      res.end(stsCredentialsXml("AssumeRoleWithWebIdentity", "AKIDWEBID", expiration));
    });
    host = new NodeTestHost({
      AWS_WEB_IDENTITY_TOKEN_FILE: TOKEN_FILE,
      AWS_ROLE_ARN: ROLE_ARN,
      AWS_ROLE_SESSION_NAME: "wasi-session",
    });
    host.writeFile(TOKEN_FILE, "header.payload.signature\n");
    const credentials = await fromWasiWebIdentity({
      host,
      clientConfig: { endpoint: server.url, region: "us-east-1" },
    })();
    expect(credentials).toMatchObject({
      accessKeyId: "AKIDWEBID",
      secretAccessKey: "web-identity-secret",
      sessionToken: "web-identity-session",
      expiration: new Date(expiration),
    });
    expect(credentials.$source).toMatchObject({
      CREDENTIALS_STS_ASSUME_ROLE_WEB_ID: "k",
      CREDENTIALS_ENV_VARS_STS_WEB_ID_TOKEN: "h",
    });
    const form = new URLSearchParams(server.requests[0].body);
    expect(form.get("Action")).toBe("AssumeRoleWithWebIdentity");
    expect(form.get("RoleArn")).toBe(ROLE_ARN);
    expect(form.get("RoleSessionName")).toBe("wasi-session");
    expect(form.get("WebIdentityToken")).toBe("header.payload.signature");
    expect(server.requests[0].headers.authorization).toBeUndefined();
  });

  it("fails the chain when STS rejects the token", async () => {
    server = await startServer((_req, res) => {
      res.statusCode = 400;
      res.setHeader("content-type", "text/xml");
      res.end(
        `<ErrorResponse><Error><Type>Sender</Type><Code>InvalidIdentityToken</Code><Message>bad jwt</Message></Error><RequestId>r</RequestId></ErrorResponse>`
      );
    });
    host = new NodeTestHost({
      AWS_WEB_IDENTITY_TOKEN_FILE: TOKEN_FILE,
      AWS_ROLE_ARN: ROLE_ARN,
    });
    host.writeFile(TOKEN_FILE, "bad");
    await expect(
      fromWasiWebIdentity({
        host,
        clientConfig: {
          endpoint: server.url,
          region: "us-east-1",
          maxAttempts: 1,
        },
      })()
    ).rejects.toMatchObject({
      tryNextLink: false,
      message: expect.stringContaining(`AssumeRoleWithWebIdentity for ${ROLE_ARN} failed: bad jwt`),
    });
  });
});
