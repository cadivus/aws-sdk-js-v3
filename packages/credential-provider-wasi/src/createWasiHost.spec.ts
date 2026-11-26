import { closeSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test as it } from "vitest";

import { createWasiHost, type WasiDescriptor } from "./createWasiHost";

/**
 * A `wasi:filesystem` descriptor implemented over real Node file handles, with
 * the WASI error shape (`payload` carrying the error code) jco uses.
 */
class NodeDescriptor implements WasiDescriptor {
  static opened = 0;
  static disposed = 0;
  private fd?: number;

  constructor(private readonly hostPath: string) {}

  openAt(
    _pathFlags: { symlinkFollow?: boolean },
    path: string,
    _openFlags: Record<string, boolean>,
    flags: { read?: boolean }
  ) {
    const child = new NodeDescriptor(join(this.hostPath, path));
    try {
      child.fd = openSync(child.hostPath, flags.read ? "r" : "r+");
    } catch (err) {
      throw Object.assign(new Error("ComponentError"), {
        payload: (err as NodeJS.ErrnoException).code === "ENOENT" ? "no-entry" : "access",
      });
    }
    NodeDescriptor.opened++;
    return child;
  }

  read(length: bigint, offset: bigint): [Uint8Array, boolean] {
    const buffer = Buffer.alloc(Number(length));
    const n = readSync(this.fd!, buffer, 0, buffer.length, Number(offset));
    return [new Uint8Array(buffer.subarray(0, n)), n === 0];
  }

  [Symbol.dispose]() {
    closeSync(this.fd!);
    NodeDescriptor.disposed++;
  }
}

describe(createWasiHost.name, () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wasi-host-"));
    NodeDescriptor.opened = 0;
    NodeDescriptor.disposed = 0;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const write = (relative: string, content: string) => {
    const path = join(root, relative);
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(path, content);
  };

  it("converts the environment list into a record", () => {
    const host = createWasiHost(
      {
        getEnvironment: () => [
          ["AWS_REGION", "us-east-1"],
          ["EMPTY", ""],
        ],
      },
      { getDirectories: () => [] }
    );
    expect(host.getEnvironment()).toEqual({
      AWS_REGION: "us-east-1",
      EMPTY: "",
    });
  });

  it("reads through the longest matching preopen and closes the file", () => {
    write("secrets/eks/token", "from-eks-preopen");
    write("all/var/run/secrets/eks/token", "shadowed");
    write("all/var/run/other/token", "from-root-preopen");
    const host = createWasiHost(
      { getEnvironment: () => [] },
      {
        getDirectories: () => [
          [new NodeDescriptor(join(root, "all")), "/"],
          [new NodeDescriptor(join(root, "secrets")), "/var/run/secrets/"],
        ],
      }
    );
    expect(host.readTextFile("/var/run/secrets/eks/token")).toBe("from-eks-preopen");
    expect(host.readTextFile("/var/run/other/token")).toBe("from-root-preopen");
    expect(NodeDescriptor.opened).toBe(2);
    expect(NodeDescriptor.disposed).toBe(2);
  });

  it("reads files larger than one chunk", () => {
    const big = "x".repeat(10_000) + "é";
    write("big", big);
    const host = createWasiHost(
      { getEnvironment: () => [] },
      { getDirectories: () => [[new NodeDescriptor(root), "/data"]] }
    );
    expect(host.readTextFile("/data/big")).toBe(big);
  });

  it("rejects files above maxFileBytes and still closes them", () => {
    write("big", "y".repeat(5000));
    const host = createWasiHost(
      { getEnvironment: () => [] },
      { getDirectories: () => [[new NodeDescriptor(root), "/data"]] },
      { maxFileBytes: 4096 }
    );
    expect(() => host.readTextFile("/data/big")).toThrow("/data/big exceeds 4096 bytes");
    expect(NodeDescriptor.disposed).toBe(1);
  });

  it("rejects relative paths, '..' segments and paths without a preopen", () => {
    const host = createWasiHost(
      { getEnvironment: () => [] },
      { getDirectories: () => [[new NodeDescriptor(root), "/data"]] }
    );
    expect(() => host.readTextFile("data/x")).toThrow("Expected an absolute path");
    expect(() => host.readTextFile("/data/../etc/passwd")).toThrow("must not contain '..'");
    expect(() => host.readTextFile("/elsewhere/x")).toThrow("No preopened directory grants access to /elsewhere/x");
    expect(() => host.readTextFile("/database/x")).toThrow("No preopened directory");
  });

  it("surfaces WASI error codes", () => {
    const host = createWasiHost(
      { getEnvironment: () => [] },
      { getDirectories: () => [[new NodeDescriptor(root), "/data"]] }
    );
    expect(() => host.readTextFile("/data/missing")).toThrow(expect.objectContaining({ payload: "no-entry" }));
  });
});
