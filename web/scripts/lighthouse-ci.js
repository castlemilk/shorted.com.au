#!/usr/bin/env node
/**
 * Lighthouse CI script for performance monitoring
 * Run with: node scripts/lighthouse-ci.js
 *
 * Requires: npm install -g @lhci/cli
 * Or use: npx @lhci/cli autorun
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3020;
const BASE_URL = `http://localhost:${PORT}`;

// Pages to test
const PAGES = ["/", "/shorts", "/stocks", "/blog", "/about"];

console.log("🚀 Starting Lighthouse CI...");
console.log(`Testing against: ${BASE_URL}`);

// Check if server is running
try {
  execSync(`curl -f ${BASE_URL} > /dev/null 2>&1`, { stdio: "ignore" });
  console.log("✅ Server is running");
} catch (e) {
  console.error("❌ Server is not running. Please start it first:");
  console.error(`   npm run dev`);
  process.exit(1);
}

// Create lighthouserc.json if it doesn't exist
const lighthousercPath = path.join(process.cwd(), ".lighthouserc.json");
if (!fs.existsSync(lighthousercPath)) {
  const config = {
    ci: {
      collect: {
        url: PAGES.map((page) => `${BASE_URL}${page}`),
        numberOfRuns: 3,
      },
      assert: {
        assertions: {
          "categories:performance": ["error", { minScore: 0.8 }],
          "categories:accessibility": ["error", { minScore: 0.9 }],
          "categories:best-practices": ["error", { minScore: 0.9 }],
          "categories:seo": ["error", { minScore: 0.9 }],
          "first-contentful-paint": ["warn", { maxNumericValue: 2000 }],
          "largest-contentful-paint": ["warn", { maxNumericValue: 2500 }],
          "cumulative-layout-shift": ["warn", { maxNumericValue: 0.1 }],
        },
      },
      upload: {
        target: "temporary-public-storage",
      },
    },
  };

  fs.writeFileSync(lighthousercPath, JSON.stringify(config, null, 2));
  console.log("✅ Created .lighthouserc.json");
}

console.log("\n📊 Running Lighthouse CI...");
console.log("This may take a few minutes...\n");

try {
  execSync("npx @lhci/cli autorun", { stdio: "inherit" });
  console.log("\n✅ Lighthouse CI completed successfully!");
} catch (e) {
  console.error(
    "\n❌ Lighthouse CI failed. Check the output above for details.",
  );
  process.exit(1);
}
