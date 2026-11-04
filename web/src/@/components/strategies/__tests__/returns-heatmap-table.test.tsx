import { render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ReturnsHeatmapTable,
  ReturnsLegend,
  type ReturnsHeatmapRow,
} from "../returns-heatmap-table";

/**
 * The style attribute as the server writes it. jsdom's CSS parser drops
 * `var()` and `color-mix()` values set through the CSSOM, so the inline styles
 * are read from the markup the server renders, where they are written verbatim.
 */
function serverDom(element: ReactElement): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(element);
  return host;
}

const COLUMNS = [
  { key: "2019", label: "2019" },
  { key: "2020", label: "2020" },
  { key: "2021", label: "2021" },
];

const ROWS: ReturnsHeatmapRow[] = [
  {
    key: "crowded",
    name: "Crowded-Short Breakout",
    sublabel: "Breakout · weeks",
    cells: [
      { state: "value", value: 14.2, coverage: 0.64 },
      { state: "value", value: -12.5, coverage: 0.96 },
      { state: "hatched", label: "Run required" },
    ],
    metrics: [
      { key: "cagr", text: "+8.1%", value: 8.1 },
      { key: "dd", text: "−18.6%", value: -18.6 },
    ],
  },
  {
    key: "minervini",
    name: "Minervini trend template",
    cells: [
      { state: "value", value: 0.2 },
      {
        state: "value",
        value: 3,
        marker: {
          glyph: "?",
          label: "Coverage measured on ASIC-reported names only",
        },
      },
      { state: "hatched", label: "Not elapsed" },
    ],
    metrics: [
      { key: "cagr", text: "n/a", value: null },
      { key: "dd", text: "−4.0%", value: -4 },
    ],
  },
];

const TABLE = (
  <ReturnsHeatmapTable
    caption="Historical returns by year, total return after costs"
    rowHeader="Strategy"
    scale="annual"
    columns={COLUMNS}
    rows={ROWS}
    metricColumns={[
      { key: "cagr", label: "CAGR" },
      { key: "dd", label: "Max DD" },
    ]}
  />
);

function renderTable() {
  return render(TABLE);
}

/** The cell (td) holding a figure, read from the server markup. */
function styledCell(text: string): HTMLElement {
  const host = serverDom(TABLE);
  return [...host.querySelectorAll("td")].find((td) =>
    td.textContent?.includes(text),
  ) as HTMLElement;
}

describe("ReturnsHeatmapTable markup", () => {
  it("is a real table with a caption that names what the figures are", () => {
    renderTable();
    const table = screen.getByRole("table");
    expect(
      within(table).getByRole("columnheader", { name: "2019" }),
    ).toBeInTheDocument();
    expect(table.querySelector("caption")?.textContent).toBe(
      "Historical returns by year, total return after costs",
    );
  });

  it("scopes the column headers to columns and the names to rows", () => {
    renderTable();
    expect(
      screen
        .getByRole("columnheader", { name: "Strategy" })
        .getAttribute("scope"),
    ).toBe("col");
    expect(
      screen
        .getByRole("rowheader", { name: /Crowded-Short Breakout/ })
        .getAttribute("scope"),
    ).toBe("row");
  });

  it("right-aligns the figures in tabular numerals", () => {
    renderTable();
    const cell = screen.getByText("+14.2%").closest("td")!;
    expect(cell.className).toContain("text-right");
    expect(cell.className).toContain("tabular-nums");
  });

  it("puts the ink on every filled figure, never the paper", () => {
    const filled = styledCell("+14.2%");
    expect(filled.getAttribute("style")).toContain(
      "color:hsl(var(--returns-ink))",
    );
    expect(filled.getAttribute("data-bin")).toBe("strong-up");
  });

  it("paints a cell from the signal over the paper, at the bin's strength", () => {
    const red = styledCell("−12.5%");
    expect(red.getAttribute("data-bin")).toBe("strong-down");
    expect(red.getAttribute("style")).toContain(
      "background:color-mix(in srgb, var(--semantic-red) 60%, hsl(var(--returns-paper)))",
    );
  });

  it("leaves an about-zero cell unfilled and in the plain foreground", () => {
    const cell = styledCell("+0.2%");
    expect(cell.getAttribute("data-bin")).toBe("flat");
    expect(cell.getAttribute("style")).toBe("color:hsl(var(--foreground))");
  });

  it("hatches a state with no figure and says what it is", () => {
    renderTable();
    const cell = screen.getByText("Run required");
    expect(cell.className).toContain("hatch-empty");
    expect(cell.getAttribute("data-state")).toBe("hatched");
  });

  it("hatches the coverage line under 80% and leaves a full one clear", () => {
    renderTable();
    expect(
      screen.getByText("cov 64%").getAttribute("data-coverage-hatched"),
    ).toBe("");
    expect(
      screen.getByText("cov 96%").getAttribute("data-coverage-hatched"),
    ).toBeNull();
    // The 64% cell is filled, so its hatch is stripes only over the fill.
    expect(screen.getByText("cov 64%").className).toContain("hatch-on-fill");
    expect(screen.getByText("cov 64%").className).not.toContain("hatch-empty");
  });

  it("keeps the coverage hatch off the muted base when the cell is unfilled", () => {
    const { container } = render(
      <ReturnsHeatmapTable
        caption="c"
        rowHeader="Strategy"
        scale="annual"
        columns={[{ key: "2019", label: "2019" }]}
        rows={[
          {
            key: "flat",
            name: "Flat year",
            cells: [{ state: "value", value: 0.2, coverage: 0.5 }],
          },
        ]}
      />,
    );
    expect(container.querySelector(".hatch-empty")).not.toBeNull();
    expect(container.querySelector(".hatch-on-fill")).toBeNull();
  });

  it("labels a marker for a screen reader, with the glyph hidden from it", () => {
    renderTable();
    expect(
      screen.getByText("Coverage measured on ASIC-reported names only"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("?", { selector: "[aria-hidden='true']" }),
    ).toBeInTheDocument();
  });

  it("sets a negative window figure in the red text token, never a fill", () => {
    const dd = styledCell("−18.6%");
    expect(dd.getAttribute("style")).toBe("color:var(--semantic-red-text)");
    expect(styledCell("+8.1%").getAttribute("style")).toBeNull();
  });

  it("prints a window figure that is not known as n/a", () => {
    renderTable();
    expect(screen.getByText("n/a")).toBeInTheDocument();
  });
});

describe("ReturnsLegend", () => {
  it("names the bins in order, and paints the middle one unfilled", () => {
    render(<ReturnsLegend scale="annual" />);
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      "≤ −10%",
      "−10 to −0.5%",
      "about 0",
      "0.5 to 10%",
      "≥ 10%",
    ]);
    const host = serverDom(<ReturnsLegend scale="annual" />);
    const swatches = [...host.querySelectorAll("li > span:first-child")];
    expect(swatches[2]!.getAttribute("style")).toBeNull();
    expect(swatches[0]!.getAttribute("style")).toContain("--semantic-red");
  });
});

describe("ReturnsHeatmapTable cells that span or print", () => {
  it("merges a run of columns into one hatched cell, and keeps the next figure under its own header", () => {
    const columns = [
      { key: "2019", label: "2019" },
      { key: "2020", label: "2020" },
      { key: "2021", label: "2021" },
      { key: "2022", label: "2022" },
    ];
    render(
      <ReturnsHeatmapTable
        caption="c"
        rowHeader="Strategy"
        scale="annual"
        columns={columns}
        rows={[
          {
            key: "zanger",
            name: "Zanger",
            cells: [
              {
                state: "hatched",
                label: "Not computable before FY2023",
                span: 3,
              },
              { state: "value", value: 4.2 },
            ],
          },
        ]}
      />,
    );
    const merged = screen
      .getByText("Not computable before FY2023")
      .closest("td")!;
    expect(merged.getAttribute("colspan")).toBe("3");
    const figure = screen.getByText("+4.2%").closest("td")!;
    expect(figure.getAttribute("data-col")).toBe("2022");
  });

  it("bins a figure as printed, so 9.96 is the same deep bin as the 10.0 it prints", () => {
    const { container } = render(
      <ReturnsHeatmapTable
        caption="c"
        rowHeader="Strategy"
        scale="annual"
        columns={[{ key: "2019", label: "2019" }]}
        rows={[
          { key: "a", name: "A", cells: [{ state: "value", value: 9.96 }] },
        ]}
      />,
    );
    expect(
      container.querySelector("td[data-bin]")?.getAttribute("data-bin"),
    ).toBe("strong-up");
  });

  it("prints n/a, and no NaN, for a coverage figure that is not a number", () => {
    const { container } = render(
      <ReturnsHeatmapTable
        caption="c"
        rowHeader="Strategy"
        scale="annual"
        columns={[{ key: "2019", label: "2019" }]}
        rows={[
          {
            key: "a",
            name: "A",
            cells: [{ state: "value", value: 1, coverage: Number.NaN }],
          },
        ]}
      />,
    );
    expect(container.textContent).not.toContain("NaN");
    expect(container.querySelector("[data-coverage-hatched]")).toBeNull();
  });

  it("prints n/a in a window column the row does not carry", () => {
    render(
      <ReturnsHeatmapTable
        caption="c"
        rowHeader="Strategy"
        scale="annual"
        columns={[{ key: "2019", label: "2019" }]}
        rows={[{ key: "a", name: "A", cells: [{ state: "value", value: 1 }] }]}
        metricColumns={[{ key: "cagr", label: "CAGR" }]}
      />,
    );
    expect(screen.getByText("n/a")).toBeInTheDocument();
  });

  it("lets the scrolling wrapper take keyboard focus, named for its caption", () => {
    render(
      <ReturnsHeatmapTable
        caption="Historical returns by year"
        rowHeader="Strategy"
        scale="annual"
        columns={[{ key: "2019", label: "2019" }]}
        rows={[]}
      />,
    );
    const region = screen.getByRole("region", {
      name: "Historical returns by year",
    });
    expect(region.getAttribute("tabindex")).toBe("0");
  });
});
