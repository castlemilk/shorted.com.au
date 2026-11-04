import { render, screen } from "@testing-library/react";

import { VersionChip } from "~/@/components/strategies/version-chip";
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

describe("VersionChip", () => {
  it("links the label and short hash to the changelog", () => {
    render(<VersionChip version={VERSION} />);
    const link = screen.getByRole("link", { name: /Rules v0 · 3f9a1c2e/ });
    expect(link).toHaveAttribute("href", "/strategies/changelog");
    expect(link).toHaveAttribute("title", "Rules v0 · 3f9a1c2e · engine 1.0.0. See the changelog.");
  });

  it("renders nothing without a version, never a placeholder", () => {
    const { container } = render(<VersionChip version={null} />);
    expect(container).toBeEmptyDOMElement();
    const empty = render(<VersionChip version={{ ...VERSION, label: "", rulesHash: "" }} />);
    expect(empty.container).toBeEmptyDOMElement();
  });
});
