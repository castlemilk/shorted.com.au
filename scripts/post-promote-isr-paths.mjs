import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOUSING_PROFILE_ROUTES = new Set([
  "/housing/[state]/[suburb]",
  "/housing/[state]/council/[slug]",
]);
const HOUSING_STATE_PATH = /^\/housing\/(?:act|nsw|nt|qld|sa|tas|vic|wa)$/;
const HOUSING_STATE_DESCENDANT = /^\/housing\/(?:act|nsw|nt|qld|sa|tas|vic|wa|\[state\])\//;

/** Select the routes the release must refresh after promotion. */
export function postPromotePaths(pages, shellPages) {
  if (!Array.isArray(pages) || pages.length === 0 || pages.some((path) => typeof path !== "string" || !path.startsWith("/"))) {
    throw new Error("ISR pages must be a non-empty array of /-prefixed paths");
  }
  if (!Array.isArray(shellPages) || shellPages.some((path) => typeof path !== "string" || !path.startsWith("/"))) {
    throw new Error("ISR shell pages must be an array of /-prefixed paths");
  }

  const shells = new Set(shellPages);
  const paths = new Set();
  for (const path of pages) {
    // The shell warmer owns these, with a separate invalidate and prime.
    if (shells.has(path) || HOUSING_PROFILE_ROUTES.has(path)) continue;

    // An untyped /housing or /housing/nsw expires its descendants on Vercel.
    // State pages share a dynamic route, so page-typing the pattern refreshes
    // the eight indexes without touching suburb or council profiles.
    if (path === "/housing") {
      throw new Error("The housing index must be handled by the shell warmer");
    }
    if (HOUSING_STATE_DESCENDANT.test(path)) {
      throw new Error(`A housing state descendant needs an explicit release scope: ${path}`);
    }
    paths.add(HOUSING_STATE_PATH.test(path) ? "/housing/[state]" : path);
  }
  return [...paths];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const pages = JSON.parse(readFileSync("web/src/config/isr-pages.json", "utf8"));
    const shells = JSON.parse(readFileSync("web/src/config/isr-shell-pages.json", "utf8"));
    const paths = postPromotePaths(pages, shells);
    console.error(`Post-promote ISR: ${paths.length} routes; housing profiles excluded.`);
    process.stdout.write(paths.join(","));
  } catch (error) {
    console.error(`Cannot select post-promote ISR paths: ${error.message}`);
    process.exitCode = 1;
  }
}
