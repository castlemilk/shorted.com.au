import {
  e2eTestEmail,
  e2eTestPassword,
  isDevOrTestRuntime,
  isE2eTestEmail,
} from "~/server/e2e-identity";

describe("the hard-coded E2E password", () => {
  it("is given only in a development or test runtime", () => {
    expect(e2eTestPassword({ NODE_ENV: "development" })).toBe(
      "E2ETestPassword123!",
    );
    expect(e2eTestPassword({ NODE_ENV: "test" })).toBe("E2ETestPassword123!");
    expect(e2eTestPassword({ NODE_ENV: "production" })).toBeUndefined();
    expect(e2eTestPassword({})).toBeUndefined();
  });

  it("an explicit E2E_TEST_PASSWORD is used everywhere, including a production build", () => {
    expect(
      e2eTestPassword({
        NODE_ENV: "production",
        E2E_TEST_PASSWORD: "preview-only",
      }),
    ).toBe("preview-only");
  });
});

describe("runtime and identity", () => {
  it("counts only development and test as the E2E runtime", () => {
    expect(isDevOrTestRuntime({ NODE_ENV: "development" })).toBe(true);
    expect(isDevOrTestRuntime({ NODE_ENV: "test" })).toBe(true);
    expect(isDevOrTestRuntime({ NODE_ENV: "production" })).toBe(false);
    expect(isDevOrTestRuntime({})).toBe(false);
  });

  it("recognises the E2E account case-insensitively, and the configured override", () => {
    expect(isE2eTestEmail(" E2E-Test@shorted.com.au ", {})).toBe(true);
    expect(isE2eTestEmail("ben@shorted.com.au", {})).toBe(false);
    expect(e2eTestEmail({ E2E_TEST_EMAIL: "qa@example.test" })).toBe(
      "qa@example.test",
    );
    expect(
      isE2eTestEmail("qa@example.test", { E2E_TEST_EMAIL: "qa@example.test" }),
    ).toBe(true);
  });
});
