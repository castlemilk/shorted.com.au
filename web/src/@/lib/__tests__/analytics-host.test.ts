import { canCollectAnalytics, isProductionAnalyticsHost } from "../analytics-host";
import { sendGaEvent } from "../analytics-events";

it.each(["shorted.com.au", "www.shorted.com.au"])("allows %s", (host) => {
  expect(isProductionAnalyticsHost(host)).toBe(true);
});

it.each(["localhost", "127.0.0.1", "::1", "shorted-com-au.vercel.app", "shorted.com.au.example.com", "preview.shorted.com.au", ""])("rejects %s", (host) => {
  expect(isProductionAnalyticsHost(host)).toBe(false);
});

it("blocks custom events on localhost even when a gtag stub exists", () => {
  const gtag = jest.fn();
  (window as unknown as { gtag?: typeof gtag }).gtag = gtag;
  expect(window.location.hostname).toBe("localhost");
  expect(canCollectAnalytics()).toBe(false);
  sendGaEvent("sign_up", { method: "email" });
  expect(gtag).not.toHaveBeenCalled();
  delete window.gtag;
});
