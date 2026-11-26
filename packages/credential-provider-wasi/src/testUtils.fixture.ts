import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WasiHost } from "./WasiHost";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export interface TestServer {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/**
 * Starts a real HTTP server on 127.0.0.1 with an ephemeral port.
 */
export const startServer = async (
  handler: (req: RecordedRequest, res: ServerResponse) => void | Promise<void>
): Promise<TestServer> => {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const recorded = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      try {
        await handler(recorded, res);
      } catch (err) {
        res.statusCode = 500;
        res.end(String(err));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

export const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

/**
 * A {@link WasiHost} for Node: a mutable environment map plus a real temporary
 * directory that stands in for the guest file system root.
 */
export class NodeTestHost implements WasiHost {
  readonly root = mkdtempSync(join(tmpdir(), "credential-provider-wasi-"));
  env: Record<string, string | undefined>;
  envReads = 0;

  constructor(env: Record<string, string | undefined> = {}) {
    this.env = env;
  }

  getEnvironment() {
    this.envReads++;
    return { ...this.env };
  }

  readTextFile(absolutePath: string) {
    return readFileSync(join(this.root, absolutePath), "utf8");
  }

  writeFile(guestPath: string, content: string): string {
    const hostPath = join(this.root, guestPath);
    const dir = hostPath.slice(0, hostPath.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(hostPath, content);
    return guestPath;
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

export const isoIn = (ms: number): string => new Date(Date.now() + ms).toISOString();

export const stsCredentialsXml = (operation: string, accessKeyId: string, expiration: string): string =>
  `<${operation}Response xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <${operation}Result>
    <Credentials>
      <AccessKeyId>${accessKeyId}</AccessKeyId>
      <SecretAccessKey>web-identity-secret</SecretAccessKey>
      <SessionToken>web-identity-session</SessionToken>
      <Expiration>${expiration}</Expiration>
    </Credentials>
    <AssumedRoleUser>
      <Arn>arn:aws:sts::123456789012:assumed-role/irsa-role/session</Arn>
      <AssumedRoleId>AROAEXAMPLE:session</AssumedRoleId>
    </AssumedRoleUser>
  </${operation}Result>
  <ResponseMetadata><RequestId>req-1</RequestId></ResponseMetadata>
</${operation}Response>`;
