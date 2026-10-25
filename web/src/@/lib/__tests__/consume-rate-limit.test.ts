// The global test setup mocks rate-limit with only rateLimit(). This file tests the
// real consumeRateLimit, so it lifts that mock.
jest.unmock("~/@/lib/rate-limit");
jest.unmock("@/lib/rate-limit");

jest.mock("~/server/auth", () => ({ auth: jest.fn() }));

import { consumeRateLimit } from "../rate-limit";

const WINDOW = {
  bucketName: "verify-email-minute",
  authenticatedLimit: 1,
  windowSeconds: 60,
};

describe("consumeRateLimit without a distributed store", () => {
  it("fails closed in production, so a send cannot be unbounded", async () => {
    const result = await consumeRateLimit("verify-email:uid-1", WINDOW, {
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv);
    expect(result.success).toBe(false);
    expect(result.retryAfterSeconds).toBe(60);
  });

  it("fails open in development, where there is no store", async () => {
    const result = await consumeRateLimit("verify-email:uid-1", WINDOW, {
      NODE_ENV: "development",
    } as NodeJS.ProcessEnv);
    expect(result.success).toBe(true);
  });

  it("honours an explicit RATE_LIMIT_FAIL_OPEN in production", async () => {
    const result = await consumeRateLimit("verify-email:uid-1", WINDOW, {
      NODE_ENV: "production",
      RATE_LIMIT_FAIL_OPEN: "true",
    } as NodeJS.ProcessEnv);
    expect(result.success).toBe(true);
  });
});
