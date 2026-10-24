import { fireEvent, render, screen, within } from "@testing-library/react";
import { ChatDataTable, Dash, type ChatDataTableColumn } from "../chat-data-table";

interface Row {
  id: string;
  name: string;
  value: number;
}

const rows: Row[] = [
  { id: "a", name: "Alpha", value: 12.5 },
  { id: "b", name: "Beta", value: 3 },
];

const columns: ChatDataTableColumn<Row>[] = [
  { id: "name", header: "Name", rowHeader: true, cell: (row) => row.name },
  { id: "value", header: "Value", numeric: true, cell: (row) => `${row.value}%` },
  { id: "note", header: "Note", cell: () => <Dash /> },
];

describe("ChatDataTable semantics", () => {
  it("is a table with a caption that names it, and a region around it", () => {
    render(
      <ChatDataTable caption="Two things" columns={columns} rows={rows} rowKey={(r) => r.id} />,
    );

    const table = screen.getByRole("table", { name: "Two things" });
    expect(within(table).getByText("Two things").tagName).toBe("CAPTION");
    expect(screen.getByRole("region", { name: "Two things" })).toBeInTheDocument();
  });

  it("scopes its headers: column headers for the head, a row header for each row's first cell", () => {
    render(
      <ChatDataTable caption="Two things" columns={columns} rows={rows} rowKey={(r) => r.id} />,
    );

    const table = screen.getByRole("table", { name: "Two things" });
    expect(within(table).getAllByRole("columnheader")).toHaveLength(3);
    expect(within(table).getAllByRole("rowheader")).toHaveLength(2);
    expect(within(table).getByRole("rowheader", { name: "Alpha" })).toBeInTheDocument();
    for (const header of within(table).getAllByRole("columnheader")) {
      expect(header).toHaveAttribute("scope", "col");
    }
    for (const header of within(table).getAllByRole("rowheader")) {
      expect(header).toHaveAttribute("scope", "row");
    }
  });

  it("right-aligns and tabulates the numeric columns, and leaves text left", () => {
    render(
      <ChatDataTable caption="Two things" columns={columns} rows={rows} rowKey={(r) => r.id} />,
    );

    const value = screen.getByRole("cell", { name: "12.5%" });
    expect(value.className).toContain("text-right");
    expect(value.className).toContain("tabular-nums");
    expect(screen.getByRole("columnheader", { name: "Value" }).className).toContain("text-right");
    expect(screen.getByRole("columnheader", { name: "Name" }).className).toContain("text-left");
  });

  it("names the rows the tool did not send, and says nothing when it sent them all", () => {
    const { rerender } = render(
      <ChatDataTable caption="Two things" columns={columns} rows={rows} rowKey={(r) => r.id} notShown={38} />,
    );
    expect(screen.getByText("38 more not shown")).toBeInTheDocument();

    rerender(
      <ChatDataTable caption="Two things" columns={columns} rows={rows} rowKey={(r) => r.id} notShown={0} />,
    );
    expect(screen.queryByText(/more not shown/)).not.toBeInTheDocument();
  });

  it("is a focusable scroll region, so a wide table can be scrolled from the keyboard", () => {
    render(
      <ChatDataTable caption="Two things" columns={columns} rows={rows} rowKey={(r) => r.id} />,
    );
    expect(screen.getByRole("region", { name: "Two things" })).toHaveAttribute("tabindex", "0");
  });

  it("reads a missing value as not available, with the dash hidden from a screen reader", () => {
    render(<Dash />);
    expect(screen.getByText("Not available")).toHaveClass("sr-only");
    expect(screen.getByText("—")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("ChatDataTable long tables", () => {
  const many: Row[] = Array.from({ length: 12 }, (_, i) => ({
    id: `r${i}`,
    name: `Row ${i}`,
    value: i,
  }));

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("makes its scrolling region the containing block of the screen-reader text in its cells", () => {
    render(<ChatDataTable caption="Twelve things" columns={columns} rows={many} rowKey={(r) => r.id} />);
    expect(screen.getByRole("region", { name: "Twelve things" }).className).toContain("relative");
  });

  it("fades the foot of a long table and says so while more of it lies below, and not once it is in view", () => {
    // jsdom has no layout: a 600px table in a 300px window, scrolled to the top.
    let scrolled = 0;
    jest.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(600);
    jest.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(300);
    jest.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(() => scrolled);

    render(<ChatDataTable caption="Twelve things" columns={columns} rows={many} rowKey={(r) => r.id} />);
    expect(screen.getByTestId("chat-table-more-below")).toBeInTheDocument();
    expect(screen.getByText("Scroll to see more rows.")).toBeInTheDocument();

    scrolled = 300;
    fireEvent.scroll(screen.getByRole("region", { name: "Twelve things" }));
    expect(screen.queryByTestId("chat-table-more-below")).not.toBeInTheDocument();
    expect(screen.queryByText("Scroll to see more rows.")).not.toBeInTheDocument();
  });

  it("shows no foot fade for a table that fits its window", () => {
    render(<ChatDataTable caption="Two things" columns={columns} rows={rows} rowKey={(r) => r.id} />);
    expect(screen.queryByTestId("chat-table-more-below")).not.toBeInTheDocument();
  });
});

describe("ChatDataTable fit and scrolling", () => {
  const many: Row[] = Array.from({ length: 12 }, (_, i) => ({
    id: `r${i}`,
    name: `Row ${i}`,
    value: i,
  }));

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("draws a table of ten rows or fewer in full, and holds a longer one to a scrolling window", () => {
    const { rerender } = render(
      <ChatDataTable caption="Two things" columns={columns} rows={rows} rowKey={(r) => r.id} />,
    );
    expect(screen.getByRole("region", { name: "Two things" }).className).not.toContain("max-h-72");

    rerender(
      <ChatDataTable caption="Two things" columns={columns} rows={many} rowKey={(r) => r.id} />,
    );
    expect(screen.getByRole("region", { name: "Two things" }).className).toContain("max-h-72");
  });

  it("fades the right edge while more of the table lies past it, and not once it is in view", () => {
    // jsdom has no layout: a 600px table in a 300px region, scrolled to the start.
    let scrolled = 0;
    jest.spyOn(Element.prototype, "scrollWidth", "get").mockReturnValue(600);
    jest.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(300);
    jest.spyOn(Element.prototype, "scrollLeft", "get").mockImplementation(() => scrolled);

    render(<ChatDataTable caption="Two things" columns={columns} rows={rows} rowKey={(r) => r.id} />);
    expect(screen.getByTestId("chat-table-more")).toBeInTheDocument();

    scrolled = 300;
    fireEvent.scroll(screen.getByRole("region", { name: "Two things" }));
    expect(screen.queryByTestId("chat-table-more")).not.toBeInTheDocument();
  });

  it("gives a row the class its caller asks for, such as a highlight", () => {
    render(
      <ChatDataTable
        caption="Two things"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowClassName={(row) => (row.id === "a" ? "bg-muted/50" : undefined)}
      />,
    );
    expect(screen.getByRole("rowheader", { name: "Alpha" }).closest("tr")).toHaveClass("bg-muted/50");
    expect(screen.getByRole("rowheader", { name: "Beta" }).closest("tr")).not.toHaveClass("bg-muted/50");
  });
});

describe("ChatDataTable width tiers", () => {
  interface Wide {
    id: string;
    name: string;
    short: string;
  }
  const wideRows: Wide[] = [{ id: "a", name: "Alpha", short: "12.50%" }];
  const wideColumns: ChatDataTableColumn<Wide>[] = [
    { id: "name", header: "Name", rowHeader: true, cell: (row) => row.name },
    {
      id: "short",
      header: "Short position",
      compactHeader: "Short",
      numeric: true,
      cell: (row, tier) => `${row.short} ${tier}`,
    },
    {
      id: "trend",
      header: "Trend",
      minTier: "standard",
      cell: () => "trend",
    },
  ];

  /** Gives every table the width a region of that many px would have, as a browser lays it out. */
  function atWidth(px: number) {
    return jest.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(px);
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("leaves out the columns that start at a wider tier, at the sidebar's width", () => {
    atWidth(300);
    render(<ChatDataTable caption="Tiers" columns={wideColumns} rows={wideRows} rowKey={(r) => r.id} />);

    expect(screen.queryByRole("columnheader", { name: /Trend/ })).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Short position" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Short position" }).textContent).toBe("Short");
  });

  it("draws every column at the /chat page's width", () => {
    atWidth(620);
    render(<ChatDataTable caption="Tiers" columns={wideColumns} rows={wideRows} rowKey={(r) => r.id} />);

    expect(screen.getByRole("columnheader", { name: "Trend" })).toBeInTheDocument();
  });

  it("draws every column when the width is not measured", () => {
    atWidth(0);
    render(<ChatDataTable caption="Tiers" columns={wideColumns} rows={wideRows} rowKey={(r) => r.id} />);

    expect(screen.getByRole("columnheader", { name: "Trend" })).toBeInTheDocument();
  });

  it("hands each cell the tier the table is drawn at", () => {
    atWidth(300);
    render(<ChatDataTable caption="Tiers" columns={wideColumns} rows={wideRows} rowKey={(r) => r.id} />);

    expect(screen.getByRole("cell", { name: "12.50% compact" })).toBeInTheDocument();
  });

  it("shows a compact header short, and keeps the full name for a screen reader", () => {
    atWidth(300);
    render(<ChatDataTable caption="Tiers" columns={wideColumns} rows={wideRows} rowKey={(r) => r.id} />);

    const header = screen.getByRole("columnheader", { name: "Short position" });
    expect(header.querySelector("abbr")).toHaveAttribute("title", "Short position");
    expect(header.querySelector("abbr")).toHaveTextContent("Short");
  });

  it("keeps the full header at the wider tiers", () => {
    atWidth(620);
    render(<ChatDataTable caption="Tiers" columns={wideColumns} rows={wideRows} rowKey={(r) => r.id} />);

    expect(screen.getByRole("columnheader", { name: "Short position" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "12.50% full" })).toBeInTheDocument();
  });
});

describe("ChatDataTable keeps a focused row clear of the sticky header", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("stops the scroll region short of the header, and each row's scroll margin clears it too", () => {
    // The header is 28px tall here. Its height is read from the header element.
    jest.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.tagName === "THEAD" ? 28 : 0;
    });
    render(<ChatDataTable caption="Two things" columns={columns} rows={rows} rowKey={(r) => r.id} />);

    const region = screen.getByRole("region", { name: "Two things" });
    expect(region.style.scrollPaddingTop).toBe("28px");
    for (const row of within(screen.getByRole("table")).getAllByRole("row").slice(1)) {
      expect(row.style.scrollMarginTop).toBe("28px");
    }
  });

  it("sets no offset before the header is measured", () => {
    render(<ChatDataTable caption="Two things" columns={columns} rows={rows} rowKey={(r) => r.id} />);

    const region = screen.getByRole("region", { name: "Two things" });
    expect(region.style.scrollPaddingTop).toBe("");
  });
});
