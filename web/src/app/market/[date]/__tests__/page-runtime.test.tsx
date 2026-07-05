/// <reference types="jest" />

import { describe, expect, it } from "@jest/globals";

describe("Market Date Page Runtime", () => {
  it("renders market date pages dynamically because server RPC fetches are no-store POSTs", async () => {
    const PageModule = await import("../page");

    expect(PageModule.dynamic).toBe("force-dynamic");
    expect(PageModule.generateStaticParams).toBeUndefined();
  });
});
