import { render, screen } from "@testing-library/react";

const getOwnershipOverview = jest.fn();

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
  }: {
    eyebrow: string;
    title: string;
    subtitle: string;
    stats?: Array<{ label: string; value: string }>;
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
    </div>
  );
  return {
    OG_SIZE: { width: 1200, height: 630 },
    OG_CONTENT_TYPE: "image/png",
    getOgLogo: async () => "data:image/png;base64,logo",
    OgCard: Card,
  };
});
jest.mock("~/app/actions/getOwnership", () => ({ getOwnershipOverview: () => getOwnershipOverview() }));

import Image from "./opengraph-image";

describe("ownership hub Open Graph image", () => {
  it("draws the hub's headline over its coverage counts, leaving out a zero", async () => {
    getOwnershipOverview.mockResolvedValue({ noticesParsed: 6367, superFunds: 72, etfs: 0 });
    const res = (await Image()) as unknown as { element: React.ReactElement };
    render(res.element);
    expect(screen.getByRole("heading")).toHaveTextContent("Who owns the ASX");
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "6,367 substantial holding notices read",
      "72 APRA-regulated super funds",
    ]);
  });

  it("degrades to the card without figures when the overview cannot be read", async () => {
    getOwnershipOverview.mockResolvedValue(undefined);
    const res = (await Image()) as unknown as { element: React.ReactElement };
    render(res.element);
    expect(screen.getByRole("heading")).toHaveTextContent("Who owns the ASX");
    expect(screen.queryByRole("list")).toBeNull();
  });
});
