import { render, screen } from "@testing-library/react";

import { CloudflareWebAnalytics } from "../cloudflare-web-analytics";

describe("CloudflareWebAnalytics", () => {
  const originalToken = process.env.NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN;
  const originalManualEnabled =
    process.env.NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_MANUAL_ENABLED;

  afterEach(() => {
    process.env.NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN = originalToken;
    process.env.NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_MANUAL_ENABLED = originalManualEnabled;
  });

  it("does not render the manual beacon by default", () => {
    const { container } = render(<CloudflareWebAnalytics token="abc123" />);

    expect(container.querySelector("script")).toBeNull();
  });

  it("does not render the manual beacon without a token", () => {
    const { container } = render(<CloudflareWebAnalytics enabled token="" />);

    expect(container.querySelector("script")).toBeNull();
  });

  it("renders the official Cloudflare beacon script when manual mode is enabled", () => {
    render(<CloudflareWebAnalytics enabled token="abc123" />);

    const script = screen.getByTestId("cloudflare-web-analytics");
    expect(script).toHaveAttribute("src", "https://static.cloudflareinsights.com/beacon.min.js");
    expect(script).toHaveAttribute("defer");
    expect(script).toHaveAttribute(
      "data-cf-beacon",
      JSON.stringify({ token: "abc123" }),
    );
  });

  it("renders the env token when manual mode is enabled by configuration", () => {
    process.env.NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_MANUAL_ENABLED = "1";
    process.env.NEXT_PUBLIC_CLOUDFLARE_WEB_ANALYTICS_TOKEN = "configured123";

    render(<CloudflareWebAnalytics />);

    expect(screen.getByTestId("cloudflare-web-analytics")).toHaveAttribute(
      "data-cf-beacon",
      JSON.stringify({ token: "configured123" }),
    );
  });
});
