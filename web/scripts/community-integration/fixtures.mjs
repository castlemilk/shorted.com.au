import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";

// The same fixture stays alive during the production build and both adapters.
// Next bakes public endpoints/rewrites into its artifact, so these cannot move
// between the build and the runtime journeys.
export function stockFixture() {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("Content-Type", "application/json");
    if (url.pathname === "/edge/v1/stock/CBA") {
      response.end(
        JSON.stringify({
          productCode: "CBA",
          name: "Synthetic Community Test Company",
          industry: "Test fixture",
          percentageShorted: 1.23,
          totalProductInIssue: 1000000,
          reportedShortPositions: 12300,
        }),
      );
    } else if (url.pathname === "/edge/v1/stock/CBA/details") {
      response.end(
        JSON.stringify({
          productCode: "CBA",
          companyName: "Synthetic Community Test Company",
          industry: "Test fixture",
          gcsUrl: "",
          logoIconGcsUrl: "",
          enrichmentStatus: "",
        }),
      );
    } else if (url.pathname.endsWith("/GetStockData")) {
      response.end(
        JSON.stringify({
          productCode: "CBA",
          points: [{ timestamp: "2026-11-03T00:00:00Z", shortPosition: 1.23 }],
        }),
      );
    } else {
      response.statusCode = 404;
      response.end(
        JSON.stringify({
          code: "not_found",
          message: "No synthetic fixture for this stock service read",
        }),
      );
    }
  });
}

export function loopbackTlsProxy({ target, keyPath, certPath }) {
  const origin = new URL(target);
  assert.equal(origin.protocol, "http:");
  assert.equal(origin.hostname, "127.0.0.1");
  assert(origin.port);
  return createHttpsServer(
    {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    },
    (request, response) => {
      // Do not resolve a client-supplied path as a URL: even an absolute request
      // target cannot turn this local test proxy into an outbound connection.
      const upstream = httpRequest(
        {
          hostname: origin.hostname,
          port: origin.port,
          method: request.method,
          path: request.url,
          headers: {
            ...request.headers,
            "x-forwarded-host": request.headers.host,
            "x-forwarded-proto": "https",
            "x-forwarded-for": "127.0.0.1",
          },
        },
        (incoming) => {
          response.writeHead(incoming.statusCode ?? 502, incoming.headers);
          incoming.pipe(response);
        },
      );
      upstream.setTimeout(30_000, () =>
        upstream.destroy(new Error("Local proxy timeout")),
      );
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end("Synthetic local upstream unavailable");
      });
      request.on("aborted", () => upstream.destroy());
      request.pipe(upstream);
    },
  );
}
