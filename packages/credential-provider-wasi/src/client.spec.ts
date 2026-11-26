import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { afterEach, describe, expect, test as it } from "vitest";

import { fromWasiRegion } from "./fromWasiRegion";
import { isoIn, NodeTestHost, startServer, stsCredentialsXml, type TestServer } from "./testUtils.fixture";
import { wasiDefaultProvider } from "./wasiDefaultProvider";

const TOKEN_FILE = "/var/run/secrets/eks.amazonaws.com/serviceaccount/token";

const callerIdentityXml = `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <GetCallerIdentityResult>
    <Arn>arn:aws:sts::123456789012:assumed-role/wasi/session</Arn>
    <UserId>AROAEXAMPLE:session</UserId>
    <Account>123456789012</Account>
  </GetCallerIdentityResult>
  <ResponseMetadata><RequestId>req-1</RequestId></ResponseMetadata>
</GetCallerIdentityResponse>`;

describe("passed explicitly to a client", () => {
  let host: NodeTestHost;
  let server: TestServer | undefined;
  afterEach(async () => {
    host?.dispose();
    await server?.close();
    server = undefined;
  });

  const stsServer = async () => {
    server = await startServer((req, res) => {
      res.setHeader("content-type", "text/xml");
      const action = new URLSearchParams(req.body).get("Action");
      res.end(
        action === "AssumeRoleWithWebIdentity"
          ? stsCredentialsXml("AssumeRoleWithWebIdentity", "AKIDWEBID", isoIn(3600_000))
          : callerIdentityXml
      );
    });
    return server;
  };

  it("signs requests with the chain's credentials and the WASI region", async () => {
    const sts = await stsServer();
    host = new NodeTestHost({
      AWS_ACCESS_KEY_ID: "AKIDENV",
      AWS_SECRET_ACCESS_KEY: "s",
      AWS_REGION: "eu-west-1",
    });
    const client = new STSClient({
      credentials: wasiDefaultProvider({ host }),
      region: fromWasiRegion({ host }),
      endpoint: sts.url,
    });
    const identity = await client.send(new GetCallerIdentityCommand({}));
    expect(identity.Account).toBe("123456789012");
    expect(sts.requests[0].headers.authorization).toMatch(/Credential=AKIDENV\/\d{8}\/eu-west-1\/sts\/aws4_request/);
  });

  it("web identity uses the calling client's region for AssumeRoleWithWebIdentity", async () => {
    const sts = await stsServer();
    host = new NodeTestHost({
      AWS_WEB_IDENTITY_TOKEN_FILE: TOKEN_FILE,
      AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/r",
      AWS_REGION: "eu-central-1",
    });
    host.writeFile(TOKEN_FILE, "jwt");
    const credentials = wasiDefaultProvider({ host, clientConfig: { endpoint: sts.url } });
    const client = new STSClient({ credentials, region: fromWasiRegion({ host }), endpoint: sts.url });
    await client.send(new GetCallerIdentityCommand({}));
    const [assume, call] = sts.requests;
    expect(new URLSearchParams(assume.body).get("Action")).toBe("AssumeRoleWithWebIdentity");
    expect(assume.headers.authorization).toBeUndefined();
    expect(call.headers.authorization).toMatch(/Credential=AKIDWEBID\/\d{8}\/eu-central-1\/sts\/aws4_request/);
  });

  it("one provider instance is shared by several clients", async () => {
    const sts = await stsServer();
    host = new NodeTestHost({
      AWS_ACCESS_KEY_ID: "AKIDENV",
      AWS_SECRET_ACCESS_KEY: "s",
      AWS_REGION: "us-east-1",
    });
    const credentials = wasiDefaultProvider({ host });
    const a = new STSClient({ credentials, region: "us-east-1", endpoint: sts.url });
    const b = new STSClient({ credentials, region: "us-east-1", endpoint: sts.url });
    await Promise.all([a.send(new GetCallerIdentityCommand({})), b.send(new GetCallerIdentityCommand({}))]);
    expect(host.envReads).toBe(1);
  });
});
