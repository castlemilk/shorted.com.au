import React from "react";
import { render } from "@testing-library/react";
import { DeferredGoogleAnalytics } from "../deferred-google-analytics";

jest.mock("next/navigation", () => ({
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

describe("DeferredGoogleAnalytics", () => {
  beforeEach(() => {
    delete (window as { dataLayer?: unknown[] }).dataLayer;
    delete (window as { gtag?: unknown }).gtag;
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
