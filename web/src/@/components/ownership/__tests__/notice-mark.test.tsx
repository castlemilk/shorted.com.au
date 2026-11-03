import { render } from "@testing-library/react";

import { NoticeMark } from "../notice-mark";

const EVENTS = ["became", "increased", "decreased", "changed", "ceased", "nz"] as const;

function markHtml(event: string): string {
  const { container, unmount } = render(<NoticeMark event={event} />);
  const html = container.innerHTML;
  unmount();
  return html;
}

describe("NoticeMark", () => {
  it.each(EVENTS)("draws %s as a hidden pictogram on a 16 by 12 grid, in the row's ink", (event) => {
    const { container } = render(<NoticeMark event={event} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("viewBox", "0 0 16 12");
    expect(svg).toHaveAttribute("stroke", "currentColor");
    expect(svg).toHaveAttribute("fill", "none");
    expect(svg).toHaveClass("h-3", "w-4");
  });

  it("gives every event its own shape, so no two read alike", () => {
    const shapes = EVENTS.map(markHtml);
    expect(new Set(shapes).size).toBe(EVENTS.length);
  });

  it("draws nothing for no event, or one the build does not know", () => {
    const empty = render(<NoticeMark event="" />);
    expect(empty.container).toBeEmptyDOMElement();
    empty.unmount();
    const unknown = render(<NoticeMark event="withdrawn" />);
    expect(unknown.container).toBeEmptyDOMElement();
  });

  it("is never red or green, whatever the event", () => {
    for (const event of EVENTS) {
      expect(markHtml(event)).not.toMatch(/red|green|#EF4444|#22C55E/i);
    }
  });
});
