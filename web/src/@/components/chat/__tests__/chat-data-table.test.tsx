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
