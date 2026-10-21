import { describe, expect, it } from "@jest/globals";
import fs from "fs";
import path from "path";

import { buildOpenAPISpec, parseOpenAPISpec } from "../parser";

/**
 * Only operation keys of a Path Item become endpoints.
 *
 * The generated spec gives /api/search/stocks and /feed.xml a path-level
 * `servers` array. The parser used to walk every key of a path, and an array
 * passes `typeof === "object"`, so it minted a 'SERVERS' endpoint for each:
 * two docs pages (/docs/api/servers--api-search-stocks and
 * /docs/api/servers--feed.xml), two sidebar entries and two sitemap URLs.
 */
describe("buildOpenAPISpec", () => {
  const document = {
    info: { title: "Fixture", version: "1" },
    paths: {
      "/feed.xml": {
        servers: [{ url: "https://shorted.com.au", description: "Web app" }],
        get: { summary: "RSS feed", tags: ["Feeds"] },
      },
      "/shorts.v1alpha1.StockService/GetStock": {
        summary: "Path-level summary",
        description: "Path-level description",
        parameters: [{ name: "x-trace", in: "header", schema: { type: "string" } }],
        post: { summary: "One stock", operationId: "GetStock", tags: ["Stocks"] },
      },
      "/reserved": {
        $ref: "#/components/pathItems/Reserved",
        head: { summary: "Probe" },
      },
    },
  };

  it("parses the operations and nothing else on the path", () => {
    const spec = buildOpenAPISpec(document);

    expect(spec.endpoints.map((e) => [e.method, e.path])).toEqual([
      ["GET", "/feed.xml"],
      ["POST", "/shorts.v1alpha1.StockService/GetStock"],
      ["HEAD", "/reserved"],
    ]);
    expect(spec.endpoints.map((e) => e.id)).toEqual([
      "get--feed.xml",
      "post--shorts.v1alpha1.stockservice-getstock",
      "head--reserved",
    ]);
  });

  it("never turns a path-level servers, parameters, summary or $ref key into an endpoint", () => {
    const ids = buildOpenAPISpec(document).endpoints.map((e) => e.id);

    for (const key of ["servers", "parameters", "summary", "description", "$ref"]) {
      expect(ids.filter((id) => id.startsWith(`${key.toLowerCase()}-`))).toEqual([]);
    }
  });

  it("groups only real operations into the navigation", () => {
    const spec = buildOpenAPISpec(document);
    expect(spec.groups.map((g) => [g.tag, g.endpoints.length])).toEqual([
      ["Feeds", 1],
      ["Stocks", 1],
      ["default", 1],
    ]);
  });
});

// A path's `servers` is data the parser keeps: it names the host that serves
// that path. OpenAPI 3 resolves operation, then path, then document.
describe("buildOpenAPISpec servers", () => {
  const spec = buildOpenAPISpec({
    servers: [{ url: "https://api.shorted.com.au" }],
    paths: {
      "/feed.xml": {
        servers: [{ url: "https://shorted.com.au", description: "Web app" }],
        get: { summary: "RSS feed" },
      },
      "/both": {
        servers: [{ url: "https://path.example" }],
        get: { servers: [{ url: "https://operation.example" }] },
      },
      "/empty": { servers: [], post: { summary: "Uses the document's" } },
      "/plain": { post: { summary: "Uses the document's" } },
    },
  });
  const servers = (path: string) => spec.endpoints.find((e) => e.path === path)?.servers;

  it("carries a path's servers onto its operations", () => {
    expect(servers("/feed.xml")).toEqual([
      { url: "https://shorted.com.au", description: "Web app" },
    ]);
  });

  it("lets an operation's servers replace its path's", () => {
    expect(servers("/both")).toEqual([{ url: "https://operation.example" }]);
  });

  it("leaves servers unset where the document's apply", () => {
    expect(servers("/empty")).toBeUndefined();
    expect(servers("/plain")).toBeUndefined();
    expect(spec.servers).toEqual([{ url: "https://api.shorted.com.au" }]);
  });
});

describe("parseOpenAPISpec on the committed spec", () => {
  const raw = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "public", "openapi.json"), "utf8"),
  ) as { paths: Record<string, Record<string, unknown>> };

  it("yields one endpoint per GET or POST operation, and no SERVERS pages", async () => {
    const { endpoints } = await parseOpenAPISpec();
    const ids = endpoints.map((e) => e.id);

    expect(ids).not.toContain("servers--api-search-stocks");
    expect(ids).not.toContain("servers--feed.xml");
    expect(ids).toContain("get--api-search-stocks");
    expect(ids).toContain("get--feed.xml");
    expect(new Set(endpoints.map((e) => e.method))).toEqual(new Set(["GET", "POST"]));

    // The spec holds no internal-only paths (openapi-postprocess prunes them),
    // so every get/post key in the document is exactly one endpoint.
    const operations = Object.values(raw.paths).flatMap((item) =>
      Object.keys(item).filter((key) => key === "get" || key === "post"),
    );
    expect(endpoints).toHaveLength(operations.length);
  });

  it("names the web app as the host of the two web-app endpoints, and no other", async () => {
    const { endpoints } = await parseOpenAPISpec();
    const withServers = endpoints
      .filter((e) => e.servers)
      .map((e) => [e.id, e.servers?.[0]?.url]);

    expect(withServers.sort()).toEqual([
      ["get--api-search-stocks", "https://shorted.com.au"],
      ["get--feed.xml", "https://shorted.com.au"],
    ]);
  });
});
