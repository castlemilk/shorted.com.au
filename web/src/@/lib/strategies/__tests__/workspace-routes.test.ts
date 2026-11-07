/// <reference types="jest" />
import * as fs from "fs";
import * as path from "path";

import { STRATEGY_SLUGS } from "~/@/lib/strategies/registry";
import { STRATEGIES_TABS, resolveStrategiesTabs } from "~/@/lib/strategies/workspace-nav";

// The workspace sub-nav's hrefs against the route tree, read from disk. Every enabled
// tab must link to a page that exists, and a tab is enabled exactly when its page ships:
// enabling a tab before its route would link the whole bar to a 404.
const APP_STRATEGIES = path.resolve(__dirname, "../../../../app/strategies");

/** The page file an href under /strategies names. A strategy slug stands for the [strategy] folder. */
function pageFileOf(href: string): string {
  const segments = href.replace(/^\/strategies\/?/, "").split("/").filter(Boolean);
  const [first, ...rest] = segments;
  if (first === undefined) return path.join(APP_STRATEGIES, "page.tsx");
  if (STRATEGY_SLUGS.includes(first)) {
    return path.join(APP_STRATEGIES, "[strategy]", ...rest, "page.tsx");
  }
  return path.join(APP_STRATEGIES, ...segments, "page.tsx");
}

describe("the workspace sub-nav against its route tree", () => {
  it.each(STRATEGIES_TABS.map((tab) => [tab.id, tab] as const))(
    "%s is enabled exactly when its page ships",
    (_id, tab) => {
      const probe = tab.id === "signals" ? `/strategies/${STRATEGY_SLUGS[0]}/signals` : tab.href;
      expect(fs.existsSync(pageFileOf(probe))).toBe(tab.enabled);
    },
  );

  it("resolves every enabled tab's href, for every strategy, to a page", () => {
    const hrefs = [null, ...STRATEGY_SLUGS].flatMap((slug) =>
      resolveStrategiesTabs(slug).map((tab) => tab.href),
    );
    for (const href of hrefs) {
      expect(fs.existsSync(pageFileOf(href))).toBe(true);
    }
  });

  it("gives Signals a page under the strategy profile for every slug", () => {
    for (const slug of STRATEGY_SLUGS) {
      expect(
        fs.existsSync(path.join(APP_STRATEGIES, "[strategy]", "signals", "page.tsx")),
      ).toBe(true);
      expect(resolveStrategiesTabs(slug).find((tab) => tab.id === "signals")?.href).toBe(
        `/strategies/${slug}/signals`,
      );
    }
  });
});
