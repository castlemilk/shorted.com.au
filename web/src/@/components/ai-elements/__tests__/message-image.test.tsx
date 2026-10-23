import { render, screen } from "@testing-library/react";
import { MessageImage } from "../message-image";

describe("MessageImage", () => {
  it("shows an image as a link to open, never as an image that loads", () => {
    const { container } = render(
      <MessageImage src="https://evil.example/track?q=the-question" alt="Chart" />,
    );

    expect(container.querySelector("img")).toBeNull();
    const link = screen.getByRole("link", { name: "Chart" });
    expect(link).toHaveAttribute("href", "https://evil.example/track?q=the-question");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
  });

  it("falls back to a label when the image has no alt text", () => {
    render(<MessageImage src="https://example.com/a.png" />);

    expect(screen.getByRole("link", { name: "Image" })).toBeInTheDocument();
  });

  it.each([
    ["javascript:alert(1)"],
    ["data:image/svg+xml;base64,PHN2Zy8+"],
    ["//evil.example/track.png"],
    [undefined],
  ])("renders no link for %s, only the text", (src) => {
    render(<MessageImage src={src} alt="Diagram" />);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Diagram")).toBeInTheDocument();
  });
});
