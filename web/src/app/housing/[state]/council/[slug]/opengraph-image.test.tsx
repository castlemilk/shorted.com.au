import { render, screen } from "@testing-library/react";

const getCouncilProfile = jest.fn();

jest.mock("next/og", () => ({
  ImageResponse: class MockImageResponse {
    element: React.ReactElement;
    constructor(element: React.ReactElement) {
      this.element = element;
    }
  },
}));
jest.mock("~/@/lib/og/card", () => {
  const Card = ({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }) => (
    <div><span>{eyebrow}</span><h1>{title}</h1><p>{subtitle}</p></div>
  );
  return {
    OG_SIZE: { width: 1200, height: 630 }, OG_CONTENT_TYPE: "image/png",
    getOgLogo: async () => "data:image/png;base64,logo", OgCard: Card, OgSilhouetteCard: Card,
  };
});
jest.mock("~/@/lib/og/state-silhouette", () => ({ getStateSilhouette: () => null }));
jest.mock("~/app/actions/getHousing", () => ({ getCouncilProfile: (...a: unknown[]) => getCouncilProfile(...a) }));

import Image from "./opengraph-image";

const params = (state: string, slug: string) => ({ params: Promise.resolve({ state, slug }) });

describe("council Open Graph image", () => {
  it("names the council and its ERP population", async () => {
    getCouncilProfile.mockResolvedValue({ profile: { summary: { displayName: "Yarra", kind: "council", population: 101_356, erpYear: 2025 } } });
    const res = (await Image(params("vic", "yarra"))) as unknown as { element: React.ReactElement };
    render(res.element);
    expect(screen.getByRole("heading")).toHaveTextContent("Yarra, Victoria");
    expect(screen.getByText(/101,356 residents \(ABS estimated resident population 2025\)/)).toBeInTheDocument();
  });

  it("degrades to the slug when the profile cannot be read", async () => {
    getCouncilProfile.mockRejectedValue(new Error("down"));
    const res = (await Image(params("nsw", "break-o-day"))) as unknown as { element: React.ReactElement };
    render(res.element);
    expect(screen.getByRole("heading")).toHaveTextContent("Break O Day, New South Wales");
  });
});
