import { render, screen, waitFor } from "@testing-library/react";
import { CloudflareJsDetections } from "./cloudflare-js-detections";

let mockedPathname = "/";

jest.mock("next/navigation", () => ({
  usePathname: () => mockedPathname,
}));

jest.mock("next/script", () => {
  const React = require("react");

  return {
    __esModule: true,
    default: ({ id, src, onReady }: any) => {
      React.useEffect(() => {
        onReady?.();
      }, [onReady]);

      return React.createElement("script", {
        "data-testid": id,
        src,
      });
    },
  };
});

describe("CloudflareJsDetections", () => {
  const originalFlag = process.env.NEXT_PUBLIC_CLOUDFLARE_JSD_MANUAL_ENABLED;

  beforeEach(() => {
    mockedPathname = "/";
    process.env.NEXT_PUBLIC_CLOUDFLARE_JSD_MANUAL_ENABLED = "";
    (window as any).cloudflare = undefined;
  });

  afterAll(() => {
    if (originalFlag === undefined) {
      delete process.env.NEXT_PUBLIC_CLOUDFLARE_JSD_MANUAL_ENABLED;
    } else {
      process.env.NEXT_PUBLIC_CLOUDFLARE_JSD_MANUAL_ENABLED = originalFlag;
    }
  });

  it("does not render the manual script when the rollout flag is disabled", () => {
    mockedPathname = "/signin";

    render(<CloudflareJsDetections />);

    expect(screen.queryByTestId("cloudflare-js-detections")).toBeNull();
  });

  it("does not render the manual script on public pages", () => {
    process.env.NEXT_PUBLIC_CLOUDFLARE_JSD_MANUAL_ENABLED = "1";
    mockedPathname = "/shorts/BHP";

    render(<CloudflareJsDetections />);

    expect(screen.queryByTestId("cloudflare-js-detections")).toBeNull();
  });

  it("renders and executes the manual script on sensitive pages", async () => {
    const executeOnce = jest.fn();
    process.env.NEXT_PUBLIC_CLOUDFLARE_JSD_MANUAL_ENABLED = "1";
    mockedPathname = "/signin";
    (window as any).cloudflare = { jsd: { executeOnce } };

    render(<CloudflareJsDetections />);

    expect(screen.getByTestId("cloudflare-js-detections")).toHaveAttribute(
      "src",
      "/cdn-cgi/challenge-platform/scripts/jsd/api.js",
    );
    await waitFor(() => expect(executeOnce).toHaveBeenCalledTimes(1));
  });
});
