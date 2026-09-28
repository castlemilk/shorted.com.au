import { render, screen } from "@testing-library/react";
import type {
  FundamentalsCoverageStatus,
  StockFundamentals,
} from "~/app/actions/getStockFundamentals";
import {
  FILINGS_LISTED_BELOW,
  FinancialsTab,
  emptyStateCopy,
} from "../financials-tab";
import { wesLike } from "./fixtures";

function withNothingHeld(status: FundamentalsCoverageStatus): StockFundamentals {
  return {
    ...wesLike(),
    periods: [],
    growth: null,
    quality: null,
    latestFiling: null,
    coverage: {
      status,
      lastAttemptAt: "2026-09-27T15:10:00Z",
      lastSuccessAt: "",
      sources: [],
    },
  };
}

const EMPTY_STATE = /Our data providers hold no|not yet collected|could not be collected/;

describe("FinancialsTab", () => {
  it("composes Latest result, Key ratios, statements, then the reports and the tax card last", () => {
    const { container } = render(
      <FinancialsTab
        stockCode="WES"
        fundamentals={wesLike()}
        reports={<section data-testid="reports-slot">reports</section>}
        taxCard={<section data-testid="tax-slot">tax</section>}
      />,
    );
    const order = Array.from(container.firstElementChild!.children).map(
      (el) =>
        el.getAttribute("data-testid") ??
        el.getAttribute("aria-labelledby") ??
        el.tagName,
    );
    expect(order).toEqual([
      "latest-result-heading",
      "key-ratios-heading",
      "financial-statements-heading",
      "reports-slot",
      "tax-slot",
    ]);
    expect(screen.queryByText(EMPTY_STATE)).not.toBeInTheDocument();
    // The stale "Key metrics" card is gone.
    expect(screen.queryByText("Key metrics")).not.toBeInTheDocument();
  });

  it("states each empty state exactly, only when nothing is held and the status is definite", () => {
    // The page streams the filings sentence into `filingsNote` only when the
    // reports slot lists a filing.
    const note = <>{FILINGS_LISTED_BELOW}</>;
    const { rerender } = render(
      <FinancialsTab
        stockCode="ABC"
        fundamentals={withNothingHeld("empty")}
        filingsNote={note}
      />,
    );
    expect(
      screen.getByText(
        "Our data providers hold no financial statements for ABC (last checked 28 Sep 2026). The company's own filings are listed below.",
      ),
    ).toBeInTheDocument();

    // The filings sentence belongs to the "empty" state only.
    rerender(
      <FinancialsTab
        stockCode="ABC"
        fundamentals={withNothingHeld("pending")}
        filingsNote={note}
      />,
    );
    expect(screen.getByText("Fundamentals not yet collected for ABC.")).toBeInTheDocument();
    expect(screen.queryByText(/listed below/)).not.toBeInTheDocument();

    rerender(
      <FinancialsTab
        stockCode="ABC"
        fundamentals={withNothingHeld("failed")}
        filingsNote={note}
      />,
    );
    expect(
      screen.getByText(
        "Fundamentals for ABC could not be collected on 28 Sep 2026; the next run retries.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/listed below/)).not.toBeInTheDocument();
  });

  it("never points at filings that are not listed", () => {
    expect(emptyStateCopy("empty", "ABC", "")).toBe(
      "Our data providers hold no financial statements for ABC.",
    );
    expect(emptyStateCopy("failed", "ABC", "")).toBe(
      "Fundamentals for ABC could not be collected; the next run retries.",
    );
    // Without a note (no filings listed, or not yet streamed) the empty state
    // says nothing about filings.
    render(<FinancialsTab stockCode="ABC" fundamentals={withNothingHeld("empty")} />);
    expect(
      screen.getByText("Our data providers hold no financial statements for ABC (last checked 28 Sep 2026)."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/listed below/)).not.toBeInTheDocument();
  });

  it("renders no empty state for a covered or unknown status, or when anything is held", () => {
    const { rerender } = render(
      <FinancialsTab stockCode="ABC" fundamentals={withNothingHeld("unknown")} />,
    );
    expect(screen.queryByText(EMPTY_STATE)).not.toBeInTheDocument();
    rerender(<FinancialsTab stockCode="ABC" fundamentals={withNothingHeld("covered")} />);
    expect(screen.queryByText(EMPTY_STATE)).not.toBeInTheDocument();
    rerender(
      <FinancialsTab
        stockCode="WES"
        fundamentals={{ ...wesLike(), coverage: { ...wesLike().coverage, status: "empty" } }}
      />,
    );
    expect(screen.queryByText(EMPTY_STATE)).not.toBeInTheDocument();
  });

  it("renders only its slots when the API failed (null)", () => {
    const { container } = render(
      <FinancialsTab
        stockCode="WES"
        fundamentals={null}
        reports={<p>reports</p>}
        taxCard={<p>tax</p>}
      />,
    );
    expect(container.textContent).toBe("reportstax");
  });
});
