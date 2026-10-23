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
  it("PAID_API_MONTHLY_LIMIT_MIN is the paid tier floor in DefaultConfig, above free", () => {
    const go = read(path.join(REPO_ROOT, "services/pkg/ratelimit/config.go"));
    const pro = goMonthlyQuota(go, "pro");
    expect(PAID_API_MONTHLY_LIMIT_MIN).toBe(pro);
    expect(goMonthlyQuota(go, "free")).toBeLessThan(PAID_API_MONTHLY_LIMIT_MIN);
    expect(goMonthlyQuota(go, "enterprise")).toBeGreaterThanOrEqual(PAID_API_MONTHLY_LIMIT_MIN);
  });

  it("terraform grants the probe identity the internal tier", () => {
    const tf = read(path.join(REPO_ROOT, "terraform/environments/prod/main.tf"));
    expect(tf).toContain(`["${PAID_PROBE_USER_ID}"]`);
  });
});
