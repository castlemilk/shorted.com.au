import { render } from "@testing-library/react";

import { PicksProvenance } from "~/@/components/picks/picks-provenance";
import type { StrategyVersionDef } from "~/@/lib/strategies/types";

const VERSION: StrategyVersionDef = {
  strategyId: "canslim",
  label: "v0",
  rulesHash: "3f9a1c2e" + "b".repeat(56),
  engineVersion: "1.0.0",
  featureSet: "fs1",
  status: "live",
  liveFrom: "",
  kind: "canonical",
  variantId: "",
};

const BASE = { asOf: "2026-11-04", coverage: 12, rowsCount: 0, universe: 40 };

describe("PicksProvenance", () => {
  it("names the rules version beside the price date", () => {
    const { container } = render(<PicksProvenance {...BASE} version={VERSION} />);
    expect(container.textContent).toContain("Rules v0 · 3f9a1c2e");
    expect(container.textContent).toContain("ASIC shorts T+4");
  });

  it("names no version when the API sent none", () => {
    const { container } = render(<PicksProvenance {...BASE} version={null} />);
    expect(container.textContent).not.toContain("Rules");
    expect(container.textContent).toContain("ASIC shorts T+4");
  });
});
