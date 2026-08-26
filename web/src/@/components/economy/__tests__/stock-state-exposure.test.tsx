import { render, screen } from "@testing-library/react";

import { StockStateExposure } from "../stock-state-exposure";

describe("StockStateExposure", () => {
  it("renders conservative exposure bands, state links, and their basis", () => {
    render(
      <StockStateExposure
        exposures={[
          {
            state: "wa",
            weight: 0.7,
            basis: "Pilbara iron ore operations",
            source: "llm",
          },
          {
            state: "qld",
            weight: 0.35,
            basis: "Queensland coal operations",
            source: "llm",
          },
          {
            state: "sa",
            weight: 0.1,
            basis: "South Australian exploration assets",
            source: "llm",
          },
        ]}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Operations exposure" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Majority of operations (estimate)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Significant operations exposure (estimate)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Some operations exposure (estimate)"),
    ).toBeInTheDocument();
    expect(screen.getByText("Pilbara iron ore operations")).toBeInTheDocument();
    expect(screen.getByText("Queensland coal operations")).toBeInTheDocument();
    expect(
      screen.getByText("South Australian exploration assets"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Western Australia" }),
    ).toHaveAttribute("href", "/economy/wa");
  });

  it("renders nothing for an empty exposure list", () => {
    const { container } = render(<StockStateExposure exposures={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("withholds headquarters-only rows from operations claims", () => {
    const { container } = render(
      <StockStateExposure
        exposures={[
          {
            state: "nsw",
            weight: 1,
            basis: "Registered head office in Sydney",
            source: "hq_fallback",
          },
        ]}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("withholds estimated rows that have no supporting basis", () => {
    const { container } = render(
      <StockStateExposure
        exposures={[{ state: "vic", weight: 0.6, basis: "", source: "llm" }]}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
