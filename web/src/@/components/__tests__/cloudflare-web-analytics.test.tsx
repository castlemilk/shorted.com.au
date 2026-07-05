import { render, screen } from "@testing-library/react";
import type { ScriptHTMLAttributes } from "react";

import { CloudflareWebAnalytics } from "../cloudflare-web-analytics";

jest.mock("next/script", () => ({
  __esModule: true,
  default: (props: ScriptHTMLAttributes<HTMLScriptElement>) => <script {...props} />,
}));

describe("CloudflareWebAnalytics", () => {
  it("does not render the beacon without a token", () => {
    const { container } = render(<CloudflareWebAnalytics token="" />);

    expect(container.querySelector("script")).toBeNull();
  });

  it("renders the official Cloudflare beacon script with a bounded token config", () => {
    render(<CloudflareWebAnalytics token="abc123" />);

    const script = screen.getByTestId("cloudflare-web-analytics");
    expect(script).toHaveAttribute("src", "https://static.cloudflareinsights.com/beacon.min.js");
    expect(script).toHaveAttribute(
      "data-cf-beacon",
      JSON.stringify({ token: "abc123", spa: true }),
    );
  });
});
