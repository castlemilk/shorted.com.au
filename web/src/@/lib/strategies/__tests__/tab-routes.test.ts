/// <reference types="jest" />
import * as fs from "fs";
import * as path from "path";

import {
  STRATEGY_TABS,
  enabledStrategyTabs,
  strategyTabHref,
} from "~/@/lib/strategies/strategy-tabs";
import { STRATEGY_SLUGS } from "~/@/lib/strategies/registry";

// The profile's route tree, read from disk. A tab sits in the registry before its page ships
// (enabled: false), so the registry and the tree must agree: a tab is enabled exactly when its
// page.tsx is there, and every page folder under the profile is a registry tab. Enabling a tab
// without its page would link every profile to a 404; a page without its tab would never be linked.
const PROFILE_DIR = path.resolve(__dirname, "../../../../app/strategies/[strategy]");

function pageDirOf(segment: string): string {
  return segment ? path.join(PROFILE_DIR, segment) : PROFILE_DIR;
}

// The file an href under the profile names: the strategy's slug stands for the [strategy] folder.
function pageFileOf(slug: string, href: string): string {
  return path.join(PROFILE_DIR, href.slice(`/strategies/${slug}`.length), "page.tsx");
}

describe("the profile's tabs against its route tree", () => {
  it.each(STRATEGY_TABS.map((tab) => [tab.id, tab] as const))(
    "%s is enabled exactly when its page ships",
    (_id, tab) => {
      expect(fs.existsSync(path.join(pageDirOf(tab.segment), "page.tsx"))).toBe(tab.enabled);
    },
  );

  it("gives every enabled tab a loading boundary beside its page", () => {
    for (const tab of enabledStrategyTabs()) {
      expect(fs.existsSync(path.join(pageDirOf(tab.segment), "loading.tsx"))).toBe(true);
    }
  });

  it("finds no page folder under the profile that the registry does not name", () => {
    const folders = fs
      .readdirSync(PROFILE_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(PROFILE_DIR, entry.name, "page.tsx")))
      .map((entry) => entry.name);
    const segments = STRATEGY_TABS.map((tab) => tab.segment).filter(Boolean);
    expect(folders.filter((name) => !segments.includes(name))).toEqual([]);
  });

  it("resolves every enabled tab's href, for every strategy, to a page under the profile", () => {
    for (const slug of STRATEGY_SLUGS) {
      for (const tab of enabledStrategyTabs()) {
        const href = strategyTabHref(slug, tab.id);
        expect(fs.existsSync(pageFileOf(slug, href))).toBe(true);
      }
    }
  });
});
