import { internalServiceSecret } from "~/server/internal-service-secret";

describe("internalServiceSecret", () => {
  it("returns INTERNAL_SERVICE_SECRET in every environment", () => {
    for (const NODE_ENV of ["production", "development", "test"]) {
      expect(
        internalServiceSecret({
          NODE_ENV,
          INTERNAL_SERVICE_SECRET: "real-secret",
        }),
      ).toBe("real-secret");
    }
  });

  it("falls back to the dev secret only in development", () => {
    expect(internalServiceSecret({ NODE_ENV: "development" })).toBe(
      "dev-internal-secret",
    );
  });

  it("throws instead of falling back in production and test", () => {
    expect(() => internalServiceSecret({ NODE_ENV: "production" })).toThrow(
      "INTERNAL_SERVICE_SECRET is not configured",
    );
    expect(() => internalServiceSecret({ NODE_ENV: "test" })).toThrow();
  });

  it("never reads INTERNAL_SECRET, the name that was never set in production", () => {
    expect(() =>
      internalServiceSecret({
        NODE_ENV: "production",
        INTERNAL_SECRET: "wrong-name",
      }),
    ).toThrow();
  });
});
