import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This package is ESM ("type": "module"), so `__dirname` is not defined.
const dirname = path.dirname(fileURLToPath(import.meta.url));

type IndexEntry = {
  id: string;
  title: string;
  name: string;
  type: "story" | "docs";
  tags?: string[];
};

// Read the built Storybook index synchronously at collection time so each story
// becomes its own test. Requires `npm run storybook:build` to have run first.
const indexPath = path.join(dirname, "../../storybook-static/index.json");
const entries: IndexEntry[] = Object.values(
  (
    JSON.parse(fs.readFileSync(indexPath, "utf8")) as {
      entries: Record<string, IndexEntry>;
    }
  ).entries,
).filter(
  (e) => e.type === "story" && !(e.tags ?? []).includes("no-visual"),
);

// Style injected after navigation to freeze every animation/transition (e.g.
// Tailwind `animate-pulse` loading skeletons) and the text caret. This is in
// addition to Playwright's config-level `animations: "disabled"`.
const FREEZE_CSS =
  "*,*::before,*::after{animation:none!important;transition:none!important;animation-duration:0s!important;caret-color:transparent!important;}";

for (const entry of entries) {
  test(`${entry.title} — ${entry.name}`, async ({ page }) => {
    await page.goto(`/iframe.html?id=${entry.id}&viewMode=story`);
    await page.addStyleTag({ content: FREEZE_CSS });

    const root = page.locator("#storybook-root");
    await expect(root).not.toBeEmpty({ timeout: 15_000 });
    await expect(page.locator(".sb-show-errordisplay")).toHaveCount(0);

    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);

    await expect(page).toHaveScreenshot(`${entry.id}.png`, {
      fullPage: false,
    });
  });
}
