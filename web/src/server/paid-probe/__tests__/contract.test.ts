/** @jest-environment node */
import { readFileSync } from "node:fs";
import path from "node:path";

import { PAID_API_MONTHLY_LIMIT_MIN, PAID_PROBE_USER_ID } from "../constants";

// Paths are relative to web/src/server/paid-probe/__tests__.
const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const WEB_ROOT = path.resolve(__dirname, "../../../..");

function read(file: string): string {
  return readFileSync(file, "utf8");
}

/** The monthly quota a tier gets from DefaultConfig, read from the Go source (not restated here). */
function goMonthlyQuota(source: string, tier: string): number {
  const match = new RegExp(`"${tier}":\\s*\\{\\s*RequestsPerMinute:\\s*\\d+,\\s*RequestsPerMonth:\\s*(\\d+)`).exec(source);
  if (!match) throw new Error(`no ${tier} tier in DefaultConfig`);
  return Number(match[1]);
}

describe("paid probe contracts", () => {
  it("PAID_API_MONTHLY_LIMIT_MIN is the API Access monthly quota in DefaultConfig, above free", () => {
    // The smallest monthly API quota the product sells for a paid API tier. Premium is
    // sold without the API Access plan, so it is not the floor.
    const go = read(path.join(REPO_ROOT, "services/pkg/ratelimit/config.go"));
    const apiAccess = goMonthlyQuota(go, "api_access");
    expect(PAID_API_MONTHLY_LIMIT_MIN).toBe(apiAccess);
    expect(goMonthlyQuota(go, "free")).toBeLessThan(PAID_API_MONTHLY_LIMIT_MIN);
    expect(goMonthlyQuota(go, "enterprise")).toBeGreaterThanOrEqual(PAID_API_MONTHLY_LIMIT_MIN);
  });

  it("terraform grants the probe identity the internal tier", () => {
    // The probe identity must be in the internal tier list, however many other ids the
    // list holds. Checked against the list itself, not its exact contents.
    const tf = read(path.join(REPO_ROOT, "terraform/environments/prod/main.tf"));
    const grant = tf
      .split("\n")
      .find((line) => line.includes("internal_tier_user_ids") && line.includes("join("));
    expect(grant).toBeDefined();
    expect(grant).toContain(`"${PAID_PROBE_USER_ID}"`);
  });
});
