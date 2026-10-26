import { render, screen } from "@testing-library/react";
import { TreemapTooltip } from "../treemap-tooltip";
import { getTooltipDataClient } from "~/app/actions/client/getTooltipData";

/**
 * The treemap tooltip shows the hovered company's stored website, and linked
 * it as it came: a `javascript:` website ran in our origin when clicked
 * (security review SEC-07). Only an http(s) URL is a link now.
 */

jest.mock("~/app/actions/client/getTooltipData", () => ({
  getTooltipDataClient: jest.fn(),
}));

function hover(website: string) {
  (getTooltipDataClient as jest.Mock).mockResolvedValue({
    stockDetails: { productCode: "BHP", companyName: "BHP Group", website, summary: "" },
    timeSeriesData: null,
  });
  return render(
    <TreemapTooltip
      productCode="BHP"
      shortPosition={1.2}
      industry="Materials"
      x={10}
      y={10}
      containerWidth={800}
      containerHeight={600}
      containerX={0}
      containerY={0}
    />,
  );
}

describe("the treemap tooltip's website", () => {
  it("links an http(s) website", async () => {
    hover("https://www.bhp.com");

    const link = await screen.findByRole("link", { name: "https://www.bhp.com" });
    expect(link).toHaveAttribute("href", "https://www.bhp.com");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it.each([["javascript:alert(document.cookie)"], ["\tjavascript:alert(1)"], ["data:text/html,<b>x</b>"], ["//evil.example"]])(
    "shows %p as text, not a link",
    async (website) => {
      const { container } = hover(website);

      expect(await screen.findByText(website.trim())).toBeInTheDocument();
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
      expect(container.querySelector("a")).toBeNull();
    },
  );
});
