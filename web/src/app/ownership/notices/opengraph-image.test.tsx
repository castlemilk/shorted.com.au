import { render, screen } from "@testing-library/react";

const loadNoticeFeed = jest.fn();

jest.mock("next/og", () => ({
  ImageResponse: class MockImageResponse {
    element: React.ReactElement;
    constructor(element: React.ReactElement) {
      this.element = element;
    }
  },
}));
jest.mock("~/@/lib/og/card", () => {
  const Card = ({
    eyebrow,
    title,
    subtitle,
    stats,
    footer,
  }: {
    eyebrow: string;
    title: string;
    subtitle: string;
    stats?: Array<{ label: string; value: string }>;
    footer: string;
  }) => (
    <div>
      <span>{eyebrow}</span>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {stats ? (
        <ul>
          {stats.map((s) => (
            <li key={s.label}>{`${s.value} ${s.label}`}</li>
          ))}
        </ul>
      ) : null}
      <span>{footer}</span>
    </div>
  );
  return {
    OG_SIZE: { width: 1200, height: 630 },
    OG_CONTENT_TYPE: "image/png",
    getOgLogo: async () => "data:image/png;base64,logo",
    OgCard: Card,
  };
});
jest.mock("~/app/actions/ownershipExplorer", () => ({
  loadNoticeFeed: (...args: unknown[]) => loadNoticeFeed(...args),
}));

import Image, { alt, revalidate } from "./opengraph-image";

describe("notices Open Graph image", () => {
  it("draws the notices headline over the default window's counts, dated by the newest notice read", async () => {
    loadNoticeFeed.mockResolvedValue({
      ok: true,
      activityOk: true,
      total: 1204,
      asOf: "2026-11-02",
      activity: { became: 37, ceased: 0, increased: 0, decreased: 0, changed: 0, nz: 0 },
    });
    const res = (await Image()) as unknown as { element: React.ReactElement };
    render(res.element);

    expect(screen.getByRole("heading")).toHaveTextContent("ASX substantial holding notices");
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "1,204 notices in the last 30 days",
      "37 became substantial",
      "0 ceased",
    ]);
    expect(screen.getByText("ASX substantial holding notices to 2026-11-02")).toBeInTheDocument();
  });

  it("degrades to the card without figures when the feed cannot be read", async () => {
    loadNoticeFeed.mockResolvedValue({ ok: false, activityOk: false, total: 0, asOf: "", activity: null });
    const res = (await Image()) as unknown as { element: React.ReactElement };
    render(res.element);

    expect(screen.getByRole("heading")).toHaveTextContent("ASX substantial holding notices");
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByText("ASX substantial holding notices", { selector: "span" })).toBeInTheDocument();
  });

  // The exact alt is the assertion: it carries no dash by construction.
  it("carries its static alt, and the page's one-hour revalidate", () => {
    expect(alt).toBe("ASX substantial holding notices, on Shorted");
    expect(revalidate).toBe(3600);
  });
});
