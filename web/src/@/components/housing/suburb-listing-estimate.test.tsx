import { create } from "@bufbuild/protobuf";
import { render, screen } from "@testing-library/react";

import { SuburbListingStatsSchema } from "~/gen/shorts/v1alpha1/housing_pb";
import { SuburbListingEstimate } from "./suburb-listing-estimate";

const fmt = (v: number) =>
  v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : `$${Math.round(v / 1000)}k`;

const stats = (over: Partial<Record<string, number>>) =>
  create(SuburbListingStatsSchema, {
    forSaleCount: 0, avgAsking: 0, medianAsking: 0,
    soldCount: 0, avgSold: 0, medianSold: 0, ...over,
  });

describe("SuburbListingEstimate", () => {
  it("renders nothing without stats, so a takedown or an uncrawled suburb is silent", () => {
    const { container } = render(
      <SuburbListingEstimate stats={undefined} suburbName="Morayfield" fmt={fmt} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the counts are present but the medians are zero", () => {
    const { container } = render(
      <SuburbListingEstimate stats={stats({ forSaleCount: 12, soldCount: 3 })} suburbName="X" fmt={fmt} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("leads with the sold median and states its sample size", () => {
    render(
      <SuburbListingEstimate
        stats={stats({ soldCount: 34, medianSold: 1_055_000, forSaleCount: 61, medianAsking: 949_000 })}
        suburbName="Morayfield"
        fmt={fmt}
      />,
    );
    // (1.055).toFixed(2) is "1.05" — 1.055 is not exactly representable.
    expect(screen.getByText("$1.05M")).toBeInTheDocument();
    expect(screen.getByText(/median sold · 34 sales/)).toBeInTheDocument();
    expect(screen.getByText("$949k")).toBeInTheDocument();
    expect(screen.getByText(/median asking · 61 listed/)).toBeInTheDocument();
  });

  it("shows asking alone when nothing has sold yet", () => {
    render(
      <SuburbListingEstimate
        stats={stats({ forSaleCount: 9, medianAsking: 700_000 })}
        suburbName="X"
        fmt={fmt}
      />,
    );
    expect(screen.queryByText(/median sold/)).not.toBeInTheDocument();
    expect(screen.getByText(/median asking · 9 listed/)).toBeInTheDocument();
  });

  /**
   * The whole reason this component is allowed to exist: it must disclaim the
   * three things it cannot support — settled-transfer provenance,
   * comparability with the official medians, and any rank.
   */
  it("states that it is not Valuer-General data, not comparable and not ranked", () => {
    const { container } = render(
      <SuburbListingEstimate
        stats={stats({ soldCount: 5, medianSold: 800_000 })}
        suburbName="Morayfield"
        fmt={fmt}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toMatch(/not from\s+Valuer-General settled transfers/);
    expect(text).toMatch(/not comparable/);
    expect(text).toMatch(/not\s+ranked/);
    // Never call it "the median house price".
    expect(text).not.toMatch(/^Median house price$/m);
  });

  it("uses the singular for a single sale", () => {
    render(
      <SuburbListingEstimate stats={stats({ soldCount: 1, medianSold: 800_000 })} suburbName="X" fmt={fmt} />,
    );
    expect(screen.getByText(/median sold · 1 sale$/)).toBeInTheDocument();
  });
});
