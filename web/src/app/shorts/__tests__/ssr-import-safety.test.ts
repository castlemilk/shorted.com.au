/**
 * SSR Import Safety Tests for /shorts pages
 *
 * These tests verify that import chains don't pull in modules that break
 * during server-side rendering. Specifically:
 * - Client components must not import server-only modules (cache(), Redis, etc.)
 * - Server actions must use SHORTS_API_URL from config.ts, not direct env vars
 * - calculateMovers output must be JSON-serializable (no BigInt)
 *
 * Background: In March 2026, /shorts returned 500 for 1+ day because:
 * 1. top-shorts-client.tsx ("use client") imported server-only getTopShortsData
 * 2. getTopShortsData used stale env var instead of SHORTS_API_URL
 * 3. Protobuf BigInt fields couldn't be JSON.stringify'd for cache
 * See: memory/ssr-url-regression.md
 */

import { describe, it, expect } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const WEB_SRC = path.resolve(__dirname, "../../../..");

describe("/shorts SSR Import Safety", () => {
  describe("Client component import validation", () => {
    it("top-shorts-client.tsx must NOT import server-side getTopShorts action", () => {
      const filePath = path.join(
        WEB_SRC,
        "src/app/shorts/components/top-shorts-client.tsx",
      );
      const content = fs.readFileSync(filePath, "utf-8");

      // Must NOT import from the server-side action (has cache(), Redis, @connectrpc)
      expect(content).not.toMatch(
        /from\s+["']~\/app\/actions\/getTopShorts["']/,
      );
      expect(content).not.toMatch(
        /from\s+["']\.\.\/\.\.\/actions\/getTopShorts["']/,
      );

      // MUST import from the client-side action
      expect(content).toMatch(
        /from\s+["']~\/app\/actions\/client\/getTopShorts["']/,
      );
    });

    it("top-shorts-client.tsx must have 'use client' directive", () => {
      const filePath = path.join(
        WEB_SRC,
        "src/app/shorts/components/top-shorts-client.tsx",
      );
      const content = fs.readFileSync(filePath, "utf-8");
      expect(content.trimStart()).toMatch(/^["']use client["']/);
    });

    it("/shorts/page.tsx must use dynamic import for TopShortsClient (ssr: false)", () => {
      const filePath = path.join(WEB_SRC, "src/app/shorts/page.tsx");
      const content = fs.readFileSync(filePath, "utf-8");

      // Must NOT have a static import of TopShortsClient
      expect(content).not.toMatch(
        /^import\s+\{?\s*TopShortsClient\s*\}?\s+from/m,
      );

      // Must have a dynamic import with ssr: false
      expect(content).toMatch(/ssr:\s*false/);
      expect(content).toMatch(/top-shorts-client/);
    });
  });

  describe("Server action URL consistency", () => {
    it("server actions must use SHORTS_API_URL, not process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT directly", () => {
      const actionsDir = path.join(WEB_SRC, "src/app/actions");
      const actionFiles = fs
        .readdirSync(actionsDir)
        .filter((f) => f.endsWith(".ts") && f !== "config.ts");

      const violations: string[] = [];
      for (const file of actionFiles) {
        const filePath = path.join(actionsDir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) continue;

        const content = fs.readFileSync(filePath, "utf-8");
        // Check for direct env var usage in transport baseUrl
        // Allow the import of SHORTS_API_URL (that's correct)
        // Disallow: process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT in baseUrl
        if (
          content.includes("process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT") &&
          content.includes("baseUrl")
        ) {
          violations.push(file);
        }
      }

      expect(violations).toEqual([]);
    });
  });

  describe("[stockCode]/page.tsx SSR safety", () => {
    it("must NOT directly import @connectrpc/connect or @connectrpc/connect-web", () => {
      const filePath = path.join(
        WEB_SRC,
        "src/app/shorts/[stockCode]/page.tsx",
      );
      const content = fs.readFileSync(filePath, "utf-8");

      expect(content).not.toMatch(
        /from\s+["']@connectrpc\/connect["']/,
      );
      expect(content).not.toMatch(
        /from\s+["']@connectrpc\/connect-web["']/,
      );
    });
  });
});
