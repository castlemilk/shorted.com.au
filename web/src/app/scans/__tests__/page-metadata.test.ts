/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";

import { siteConfig } from "~/@/config/site";
import { metadata } from "../page";

/**
 * The /scans title as a SERP shows it. The page sets a plain string, and the
 * root layout's template (app/layout.tsx: `%s | ${siteConfig.name}`) appends
 * the brand, so the rendered title is composed here from those parts. It was
 * 75 characters on 2026-10-21 ("ASX Short Interest Scans — Rising Shorts,
 * Covering & Squeeze Fuel | Shorted"), past the ~65 a result shows.
 */
const rendered = (title: string): string => `${title} | ${siteConfig.name}`;

describe("/scans metadata", () => {
  it("renders a title a search result shows whole, leading with the head term", () => {
    expect(typeof metadata.title).toBe("string");
    const title = rendered(metadata.title as string);

    expect(title.length).toBeLessThanOrEqual(65);
    expect(title).toMatch(/^ASX Short Interest Scans\b/);
    // The template brands it once; the page must not brand it again.
    expect(title.match(/Shorted/g)).toHaveLength(1);
  });
});
