import { render, screen, within } from "@testing-library/react";
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
