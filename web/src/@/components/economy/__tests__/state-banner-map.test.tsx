import { render, screen } from "@testing-library/react";

import { StateBannerMap } from "../state-banner-map";
import { useTopojson } from "@/components/housing/use-topojson";
import { buildStateSilhouetteModel } from "../state-banner-geometry";

jest.mock("@/components/housing/use-topojson", () => ({
  useTopojson: jest.fn(),
}));
jest.mock("../state-banner-geometry", () => ({
  STATE_SILHOUETTE_FRAME: {
    width: 360,
    height: 260,
    paddingX: 52,
    paddingY: 38,
  },
  buildStateSilhouetteModel: jest.fn(),
}));

describe("StateBannerMap", () => {
  it("renders the projected feature in a centred, aspect-preserving SVG frame", () => {
    const topology = { type: "Topology", objects: {}, arcs: [] };
    jest.mocked(useTopojson).mockReturnValue({ data: topology } as never);
    jest.mocked(buildStateSilhouetteModel).mockReturnValue({
      d: "M52,38L308,222Z",
      featureId: "1",
    });

    render(<StateBannerMap state="nsw" name="New South Wales" />);

    const svg = screen.getByRole("img", { name: "New South Wales silhouette" });
    expect(svg).toHaveAttribute("viewBox", "0 0 360 260");
    expect(svg).toHaveAttribute("preserveAspectRatio", "xMidYMid meet");
    expect(svg.querySelector("path")).toHaveAttribute("d", "M52,38L308,222Z");
    expect(buildStateSilhouetteModel).toHaveBeenCalledWith(topology, "nsw");
  });
});
