/// <reference types="jest" />
import { describe, expect, it } from "@jest/globals";

/**
 * /alerts is the Premium monitor builder, an account tool. The 2026-10-21 probe
 * found it indexable with 211 words, no canonical and the title "Alerts —
 * Shorted | Shorted" (robots.txt disallows `/alerts/`, not the bare path).
 */

jest.mock("~/app/actions/alerts", () => ({ createAlertMonitor: jest.fn() }));
jest.mock("~/app/actions/industry/getIndustryData", () => ({
  getIndustryData: jest.fn(async () => []),
}));

import { metadata } from "../page";

describe("/alerts metadata", () => {
  it("is noindexed with its links still followed", () => {
    expect(metadata.robots).toEqual({ index: false, follow: true });
  });

  it("folds the ?industry= deep links into one canonical", () => {
    expect(metadata.alternates?.canonical).toBe("https://shorted.com.au/alerts");
  });

  it("leaves the brand to the root template", () => {
    expect(metadata.title).toBe("Short-Interest Alerts");
  });
});
