import { afterEach, describe, expect, test as it } from "vitest";

import { fromWasiRegion } from "./fromWasiRegion";
import { NodeTestHost } from "./testUtils.fixture";

describe(fromWasiRegion.name, () => {
  let host: NodeTestHost;
  afterEach(() => host?.dispose());

  it("prefers AWS_REGION over AWS_DEFAULT_REGION", async () => {
    host = new NodeTestHost({
      AWS_REGION: "eu-central-1",
      AWS_DEFAULT_REGION: "us-west-2",
    });
    await expect(fromWasiRegion({ host })()).resolves.toBe("eu-central-1");
  });

  it("falls back to AWS_DEFAULT_REGION", async () => {
    host = new NodeTestHost({
      AWS_REGION: "",
      AWS_DEFAULT_REGION: "us-west-2",
    });
    await expect(fromWasiRegion({ host })()).resolves.toBe("us-west-2");
  });

  it("fails with an actionable message when no region is set", async () => {
    host = new NodeTestHost();
    await expect(fromWasiRegion({ host })()).rejects.toMatchObject({
      name: "ProviderError",
      message: expect.stringContaining("Region is missing: set AWS_REGION"),
    });
  });

  it("reads the environment lazily", async () => {
    host = new NodeTestHost();
    const provider = fromWasiRegion({ host });
    expect(host.envReads).toBe(0);
    host.env.AWS_REGION = "ap-northeast-1";
    await expect(provider()).resolves.toBe("ap-northeast-1");
  });
});
