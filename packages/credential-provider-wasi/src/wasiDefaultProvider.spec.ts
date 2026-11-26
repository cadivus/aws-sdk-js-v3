import { afterEach, describe, expect, test as it } from "vitest";

import { isoIn, json, NodeTestHost, startServer, stsCredentialsXml, type TestServer } from "./testUtils.fixture";
import { wasiDefaultProvider } from "./wasiDefaultProvider";

const TOKEN_FILE = "/var/run/secrets/eks.amazonaws.com/serviceaccount/token";

const envCreds = {
  AWS_ACCESS_KEY_ID: "AKIDENV",
  AWS_SECRET_ACCESS_KEY: "env-secret",
};

describe(wasiDefaultProvider.name, () => {
  let host: NodeTestHost;
  const servers: TestServer[] = [];
  afterEach(async () => {
    host?.dispose();
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  const containerServer = async (expiration = () => isoIn(6 * 3600_000), key = () => "AKIDECS") => {
    const server = await startServer((_req, res) =>
      json(res, 200, {
        AccessKeyId: key(),
        SecretAccessKey: "ecs-secret",
        Token: "ecs-session",
        Expiration: expiration(),
      })
    );
    servers.push(server);
    return server;
  };

  const imdsServer = async () => {
    const server = await startServer((req, res) => {
      if (req.method === "PUT") {
        return void res.end("tok");
      }
      if (req.url.endsWith("/security-credentials/")) {
        return void res.end("role");
      }
      json(res, 200, {
        AccessKeyId: "AKIDIMDS",
        SecretAccessKey: "s",
        Token: "t",
        Expiration: isoIn(3600_000),
      });
    });
    servers.push(server);
    return server;
  };

  const stsServer = async () => {
    const server = await startServer((_req, res) => {
      res.setHeader("content-type", "text/xml");
      res.end(stsCredentialsXml("AssumeRoleWithWebIdentity", "AKIDWEBID", isoIn(3600_000)));
    });
    servers.push(server);
    return server;
  };

  describe("precedence", () => {
    it("env > web identity > container > IMDS", async () => {
      const [container, imds, sts] = await Promise.all([containerServer(), imdsServer(), stsServer()]);
      host = new NodeTestHost();
      host.writeFile(TOKEN_FILE, "jwt");
      const all = {
        ...envCreds,
        AWS_WEB_IDENTITY_TOKEN_FILE: TOKEN_FILE,
        AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/r",
        AWS_CONTAINER_CREDENTIALS_FULL_URI: `${container.url}/creds`,
        AWS_EC2_METADATA_SERVICE_ENDPOINT: imds.url,
      };
      const clientConfig = { endpoint: sts.url, region: "us-east-1" };
      const resolve = async (env: Record<string, string>) => {
        host.env = env;
        return (await wasiDefaultProvider({ host, clientConfig })()).accessKeyId;
      };
      expect(await resolve(all)).toBe("AKIDENV");
      const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, ...noEnv } = all;
      expect(await resolve(noEnv)).toBe("AKIDWEBID");
      const { AWS_WEB_IDENTITY_TOKEN_FILE, AWS_ROLE_ARN, ...noWebIdentity } = noEnv;
      expect(await resolve(noWebIdentity)).toBe("AKIDECS");
      const { AWS_CONTAINER_CREDENTIALS_FULL_URI, ...imdsOnly } = noWebIdentity;
      expect(await resolve(imdsOnly)).toBe("AKIDIMDS");
      expect(sts.requests).toHaveLength(1);
      expect(container.requests).toHaveLength(1);
      expect(imds.requests).toHaveLength(3);
    });

    it("does not fall through when a configured provider fails", async () => {
      const imds = await imdsServer();
      host = new NodeTestHost({
        AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://127.0.0.1:1/creds",
        AWS_EC2_METADATA_SERVICE_ENDPOINT: imds.url,
      });
      await expect(wasiDefaultProvider({ host, maxRetries: 0, timeout: 200 })()).rejects.toMatchObject({
        tryNextLink: false,
        message: expect.stringContaining("Container credentials endpoint http://127.0.0.1:1/creds failed"),
      });
      expect(imds.requests).toHaveLength(0);
    });

    it("tries extra providers after the built-in ones", async () => {
      host = new NodeTestHost();
      const calls: unknown[] = [];
      const provider = wasiDefaultProvider({
        host,
        extraProviders: [
          async (props) => {
            calls.push(props);
            return { accessKeyId: "AKIDHOST", secretAccessKey: "host" };
          },
        ],
      });
      const props = {
        callerClientConfig: { region: async () => "us-east-1" },
      } as any;
      await expect(provider(props)).resolves.toMatchObject({
        accessKeyId: "AKIDHOST",
      });
      expect(calls).toEqual([props]);
    });
  });

  describe("errors", () => {
    it("lists the providers that were tried", async () => {
      host = new NodeTestHost();
      await expect(wasiDefaultProvider({ host })()).rejects.toMatchObject({
        name: "CredentialsProviderError",
        tryNextLink: false,
        message:
          "Could not load credentials from any providers (tried: wasi env, web identity, container endpoint, IMDS (opt-in)).",
      });
      await expect(
        wasiDefaultProvider({
          host,
          extraProviders: [async () => Promise.reject(Object.assign(new Error("x"), { tryNextLink: true }))],
        })()
      ).rejects.toThrow("(tried: wasi env, web identity, container endpoint, IMDS (opt-in), 1 extra provider(s)).");
    });

    it("does not cache failures", async () => {
      host = new NodeTestHost();
      const provider = wasiDefaultProvider({ host });
      await expect(provider()).rejects.toThrow("Could not load credentials");
      host.env = envCreds;
      await expect(provider()).resolves.toMatchObject({
        accessKeyId: "AKIDENV",
      });
    });
  });

  describe("memoization and refresh", () => {
    it("fetches once for concurrent and repeated calls", async () => {
      const container = await containerServer();
      host = new NodeTestHost({
        AWS_CONTAINER_CREDENTIALS_FULL_URI: `${container.url}/creds`,
      });
      const provider = wasiDefaultProvider({ host });
      const results = await Promise.all([provider(), provider(), provider()]);
      await provider();
      expect(new Set(results).size).toBe(1);
      expect(container.requests).toHaveLength(1);
    });

    it("never expiring credentials are not refreshed", async () => {
      host = new NodeTestHost(envCreds);
      const provider = wasiDefaultProvider({ host });
      await provider();
      const reads = host.envReads;
      await provider();
      await provider();
      expect(host.envReads).toBe(reads);
    });

    it("refreshes credentials that expire inside the refresh window", async () => {
      let n = 0;
      const container = await containerServer(
        () => isoIn(60_000),
        () => `AKIDECS${++n}`
      );
      host = new NodeTestHost({
        AWS_CONTAINER_CREDENTIALS_FULL_URI: `${container.url}/creds`,
      });
      const provider = wasiDefaultProvider({ host });
      expect((await provider()).accessKeyId).toBe("AKIDECS1");
      expect((await provider()).accessKeyId).toBe("AKIDECS2");
      expect(container.requests).toHaveLength(2);
    });

    it("coalesces concurrent refreshes", async () => {
      let n = 0;
      const container = await containerServer(
        () => isoIn(60_000),
        () => `AKIDCO${++n}`
      );
      host = new NodeTestHost({
        AWS_CONTAINER_CREDENTIALS_FULL_URI: `${container.url}/creds`,
      });
      const provider = wasiDefaultProvider({ host });
      await provider();
      const refreshed = await Promise.all([provider(), provider(), provider()]);
      expect(refreshed.map((c) => c.accessKeyId)).toEqual(["AKIDCO2", "AKIDCO2", "AKIDCO2"]);
      expect(container.requests).toHaveLength(2);
    });

    it("forceRefresh re-runs the chain for long-lived credentials", async () => {
      let n = 0;
      const container = await containerServer(undefined, () => `AKIDFORCE${++n}`);
      host = new NodeTestHost({
        AWS_CONTAINER_CREDENTIALS_FULL_URI: `${container.url}/creds`,
      });
      const provider = wasiDefaultProvider({ host });
      expect((await provider()).accessKeyId).toBe("AKIDFORCE1");
      expect((await provider()).accessKeyId).toBe("AKIDFORCE1");
      expect((await provider({ forceRefresh: true })).accessKeyId).toBe("AKIDFORCE2");
    });

    it("passes identity properties to the providers", async () => {
      host = new NodeTestHost();
      const seen: unknown[] = [];
      const props = { callerClientConfig: { region: async () => "eu-west-1" } } as any;
      await wasiDefaultProvider({
        host,
        extraProviders: [
          async (p) => {
            seen.push(p);
            return { accessKeyId: "AKIDPROPS", secretAccessKey: "s", expiration: new Date(Date.now() + 1000) };
          },
        ],
      })(props);
      expect(seen).toEqual([props]);
    });

    it("re-fetches synchronously once credentials have expired", async () => {
      let n = 0;
      const container = await containerServer(
        () => isoIn(-1000),
        () => `AKIDEXP${++n}`
      );
      host = new NodeTestHost({
        AWS_CONTAINER_CREDENTIALS_FULL_URI: `${container.url}/creds`,
      });
      const provider = wasiDefaultProvider({ host });
      expect((await provider()).accessKeyId).toBe("AKIDEXP1");
      expect((await provider()).accessKeyId).toBe("AKIDEXP2");
    });

    it("keeps serving still-valid credentials when a refresh fails", async () => {
      let n = 0;
      const server = await startServer((_req, res) =>
        ++n === 1
          ? json(res, 200, {
              AccessKeyId: "AKIDOK",
              SecretAccessKey: "s",
              Token: "t",
              Expiration: isoIn(60_000),
            })
          : json(res, 500, {})
      );
      servers.push(server);
      host = new NodeTestHost({
        AWS_CONTAINER_CREDENTIALS_FULL_URI: `${server.url}/creds`,
      });
      const provider = wasiDefaultProvider({ host, maxRetries: 0 });
      await provider();
      await provider();
      await new Promise((r) => setTimeout(r, 100));
      await expect(provider()).resolves.toMatchObject({
        accessKeyId: "AKIDOK",
      });
    });

    it("honours a custom refresh window", async () => {
      let n = 0;
      const container = await containerServer(
        () => isoIn(60_000),
        () => `AKIDWIN${++n}`
      );
      host = new NodeTestHost({
        AWS_CONTAINER_CREDENTIALS_FULL_URI: `${container.url}/creds`,
      });
      const provider = wasiDefaultProvider({ host, refreshWindowMs: 1000 });
      await provider();
      await provider();
      await new Promise((r) => setTimeout(r, 50));
      expect((await provider()).accessKeyId).toBe("AKIDWIN1");
      expect(container.requests).toHaveLength(1);
    });
  });
});
