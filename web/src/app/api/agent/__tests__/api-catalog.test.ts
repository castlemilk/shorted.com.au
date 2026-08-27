import { GET as catalogGet } from "../api-catalog/route";

describe("RFC 9727 api-catalog", () => {
  it("advertises the spec, the docs, the markdown twin and llms.txt", async () => {
    const res = catalogGet();
    const body = await res.json();
    const hrefs = JSON.stringify(body.linkset[0]);

    expect(hrefs).toContain("/openapi.json");
    expect(hrefs).toContain("/openapi.yaml");
    expect(hrefs).toContain("/docs/api.md");
    expect(hrefs).toContain("/llms.txt");
  });

  it("advertises the MCP server and its server card", async () => {
    const res = catalogGet();
    const body = await res.json();
    const hrefs = JSON.stringify(body.linkset[0]);

    // The Go server, not the deprecated Next.js shim at /api/mcp/mcp.
    expect(hrefs).toContain("https://api.shorted.com.au/mcp");
    expect(hrefs).not.toContain("/api/mcp/mcp");
    expect(hrefs).toContain("/.well-known/mcp/server-card.json");
  });

  it("is served as application/linkset+json", () => {
    const res = catalogGet();
    expect(res.headers.get("Content-Type")).toContain(
      "application/linkset+json",
    );
  });
});
