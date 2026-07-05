/// <reference types="jest" />

import { describe, expect, it } from "@jest/globals";

describe("Report Pages Runtime", () => {
  it("renders weekly report pages dynamically because server RPC fetches are no-store POSTs", async () => {
    const PageModule = await import("../weekly/[slug]/page");

    expect(PageModule.dynamic).toBe("force-dynamic");
    expect(PageModule.generateStaticParams).toBeUndefined();
  });

  it("renders monthly report pages dynamically because server RPC fetches are no-store POSTs", async () => {
    const PageModule = await import("../monthly/[slug]/page");

    expect(PageModule.dynamic).toBe("force-dynamic");
    expect(PageModule.generateStaticParams).toBeUndefined();
  });

  it("renders yearly report pages dynamically because server RPC fetches are no-store POSTs", async () => {
    const PageModule = await import("../yearly/[slug]/page");

    expect(PageModule.dynamic).toBe("force-dynamic");
    expect(PageModule.generateStaticParams).toBeUndefined();
  });
});
