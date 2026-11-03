/** @jest-environment node */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import isrShellPages from "~/config/isr-shell-pages.json";

// The warm call reads the shell list CONCURRENCY pages at a time, and each batch
// waits for its slowest page. readPage allows /price-drops 60 s and every other page
// 30 s (SLOWEST_PAGE_S and PAGE_S here, which must follow it), so the batch that
// holds /price-drops can take 60 s and each other batch 30 s. The post-deploy smoke
// allows the call 145 s, and the route's maxDuration has to cover the same worst
// case. The route cannot export CONCURRENCY (Next refuses unknown exports), so it is
// read from the source.

const CALLER_BUDGET_S = 145;
const SLOWEST_PAGE_S = 60;
const PAGE_S = 30;

const routeSource = readFileSync(join(__dirname, "..", "route.ts"), "utf8");

function literal(pattern: RegExp): number {
  const match = pattern.exec(routeSource);
  if (!match) throw new Error(`route.ts has no literal for ${pattern.source}`);
  return Number(match[1]);
}

describe("warm-cache read budget", () => {
  it("reads the shell list inside the callers' 145 s and the route's maxDuration", () => {
    const concurrency = literal(/const CONCURRENCY = (\d+);/);
    const maxDuration = literal(/export const maxDuration = (\d+);/);
    const batches = Math.ceil(isrShellPages.length / concurrency);
    const worstCase = SLOWEST_PAGE_S + PAGE_S * (batches - 1);

    expect(worstCase).toBeLessThanOrEqual(CALLER_BUDGET_S);
    expect(worstCase).toBeLessThanOrEqual(maxDuration);
  });
});
