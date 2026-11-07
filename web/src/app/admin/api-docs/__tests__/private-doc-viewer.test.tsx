import { act, fireEvent, render, screen } from "@testing-library/react";

jest.mock("../markdown-preview", () => ({
  MarkdownPreview: ({ markdown }: { markdown: string }) => <div data-testid="rendered">{markdown.slice(0, 20)}</div>,
}));

import { PrivateDocViewer } from "../private-doc-viewer";

const MARKDOWN = "# Shorted market moves posting API\n\n## POST /v1/market-moves\n\nBody fields.\n";

function renderViewer(slug = "market-moves") {
  return render(<PrivateDocViewer slug={slug} title="Market moves posting API" description="For the workflow." markdown={MARKDOWN} />);
}

describe("PrivateDocViewer", () => {
  const writeText = jest.fn();
  beforeEach(() => {
    writeText.mockReset();
    Object.assign(navigator, { clipboard: { writeText } });
  });

  it("copies the whole document as markdown", async () => {
    writeText.mockResolvedValue(undefined);
    renderViewer();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy markdown" }));
    });
    expect(writeText).toHaveBeenCalledWith(MARKDOWN);
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("shows the raw markdown to copy by hand when the clipboard is refused", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    renderViewer("private-api");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy markdown" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Copying failed");
    expect(screen.getByTestId("private-api-markdown").textContent).toBe(MARKDOWN);
  });

  it("downloads the document as a .md file", () => {
    const createObjectURL = jest.fn(() => "blob:doc");
    const revokeObjectURL = jest.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    renderViewer();
    fireEvent.click(screen.getByRole("button", { name: "Download .md" }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = (createObjectURL.mock.calls[0] as unknown as [Blob])[0];
    expect(blob.type).toBe("text/markdown;charset=utf-8");
    expect(click).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:doc");
    click.mockRestore();
  });

  it("opens the market-moves document by default and switches between views", () => {
    renderViewer();
    expect(screen.getByTestId("rendered")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    expect(screen.getByTestId("market-moves-markdown").textContent).toBe(MARKDOWN);
    fireEvent.click(screen.getByRole("button", { name: "Hide document" }));
    expect(screen.queryByTestId("market-moves-markdown")).not.toBeInTheDocument();
  });

  it("keeps the other documents closed until asked", () => {
    renderViewer("private-api");
    expect(screen.queryByTestId("rendered")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show document" }));
    expect(screen.getByTestId("rendered")).toBeInTheDocument();
  });
});
