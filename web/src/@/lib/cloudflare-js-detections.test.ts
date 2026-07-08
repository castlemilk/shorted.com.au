import {
  isCloudflareJsDetectionPath,
  isCloudflareJsDetectionsManualEnabled,
  normalizePathname,
} from "./cloudflare-js-detections";

describe("Cloudflare JavaScript Detections routing policy", () => {
  it.each([
    ["/signin"],
    ["/signup"],
    ["/dashboards"],
    ["/dashboards/positions"],
    ["/portfolio"],
    ["/alerts"],
    ["/chat"],
    ["/admin/broadcasts"],
    ["/developer"],
    ["/subscribe/success"],
    ["/unsubscribe"],
    ["/api/auth/signin"],
    ["/api/stripe/checkout"],
    ["/api/community/votes"],
    ["/chat.v1.ChatService/Stream"],
    ["/shorts/BHP/community"],
    ["/shorts/BHP/community/thread-1"],
  ])("treats %s as sensitive", (path) => {
    expect(isCloudflareJsDetectionPath(path)).toBe(true);
  });

  it.each([
    ["/"],
    ["/shorts"],
    ["/shorts/BHP"],
    ["/shorts/BHP/news"],
    ["/stocks"],
    ["/news"],
    ["/blog/market-wrap"],
    ["/pricing"],
    ["/docs/api"],
    ["/api/health"],
    ["/api/market-data/historical"],
    ["/_next/static/app.js"],
    ["/assets/logo.png"],
  ])("leaves public/cache-heavy path %s without manual JSD", (path) => {
    expect(isCloudflareJsDetectionPath(path)).toBe(false);
  });

  it("normalizes query strings, hashes, and trailing slashes", () => {
    expect(normalizePathname("signin?callbackUrl=%2Fportfolio")).toBe(
      "/signin",
    );
    expect(normalizePathname("/dashboards/#positions")).toBe("/dashboards");
  });

  it.each(["1", "true", "TRUE", "yes", "on"])(
    "enables the manual loader for %s",
    (value) => {
      expect(isCloudflareJsDetectionsManualEnabled(value)).toBe(true);
    },
  );

  it.each([undefined, "", "0", "false", "off", "no"])(
    "keeps the manual loader disabled for %s",
    (value) => {
      expect(isCloudflareJsDetectionsManualEnabled(value)).toBe(false);
    },
  );
});
