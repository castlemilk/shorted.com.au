/** @jest-environment-options {"url":"https://shorted.com.au/"} */
import React from "react";
import { render } from "@testing-library/react";
import { DeferredGoogleAnalytics } from "../deferred-google-analytics";
import { canCollectAnalytics } from "~/@/lib/analytics-host";
import { usePathname, useSearchParams } from "next/navigation";

jest.mock("~/@/lib/analytics-host", () => ({
  canCollectAnalytics: jest.fn(() => true),
}));

jest.mock("next/navigation", () => ({
  usePathname: jest.fn(() => "/"),
  useSearchParams: jest.fn(() => new URLSearchParams()),
}));

describe("DeferredGoogleAnalytics", () => {
  beforeEach(() => {
    jest.mocked(canCollectAnalytics).mockReturnValue(true);
    jest.mocked(usePathname).mockReturnValue("/");
    delete (window as { dataLayer?: unknown[] }).dataLayer;
    delete (window as { gtag?: unknown }).gtag;
  });

  it("removes callback and identity query strings from SPA page-view params", () => {
    const { rerender } = render(<DeferredGoogleAnalytics gaId="G-TEST123" />);
    jest.mocked(usePathname).mockReturnValue("/signup");
    jest.mocked(useSearchParams).mockReturnValue(new URLSearchParams("email=private@example.com&callbackUrl=secret") as never);
    rerender(<DeferredGoogleAnalytics gaId="G-TEST123" />);
    const entry = window.dataLayer!.at(-1) as ArrayLike<unknown>;
    expect(entry[0]).toBe("event");
    expect(entry[1]).toBe("page_view");
    expect(entry[2]).toEqual({ page_path: "/signup", page_location: "https://shorted.com.au/signup" });
  });

  it("does not create a queue or collector outside production hosts", () => {
    jest.mocked(canCollectAnalytics).mockReturnValue(false);
    render(<DeferredGoogleAnalytics gaId="G-TEST123" />);
    expect(window.dataLayer).toBeUndefined();
    expect(window.gtag).toBeUndefined();
    expect(document.querySelector('script[src*="googletagmanager"]')).toBeNull();
  });

  it("queues gtag commands as Arguments objects, not arrays", () => {
    render(<DeferredGoogleAnalytics gaId="G-TEST123" />);

    const dataLayer = window.dataLayer!;
    expect(dataLayer.length).toBeGreaterThanOrEqual(2);

    // gtag.js only executes dataLayer entries that are [object Arguments];
    // plain arrays are silently ignored. The array-shaped stub shipped
    // 2026-07-16 zeroed out ALL GA traffic until 2026-07-25 — never again.
    for (const entry of dataLayer) {
      expect(Object.prototype.toString.call(entry)).toBe("[object Arguments]");
    }

    const commands = dataLayer.map((e) => (e as ArrayLike<unknown>)[0]);
    expect(commands[0]).toBe("js");
    expect(commands[1]).toBe("config");
    expect((dataLayer[1] as ArrayLike<unknown>)[1]).toBe("G-TEST123");
  });

  it("routes later gtag() calls through the same Arguments-shaped stub", () => {
    render(<DeferredGoogleAnalytics gaId="G-TEST123" />);
    const before = window.dataLayer!.length;

    window.gtag!("event", "page_view", { page_path: "/x" });

    const entry = window.dataLayer![before]!;
    expect(Object.prototype.toString.call(entry)).toBe("[object Arguments]");
    expect((entry as ArrayLike<unknown>)[0]).toBe("event");
  });
});
