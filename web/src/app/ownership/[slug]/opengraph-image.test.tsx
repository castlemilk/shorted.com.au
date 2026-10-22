import { render, screen } from "@testing-library/react";

const getInstitution = jest.fn();

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
jest.mock("~/app/actions/getOwnership", () => ({ getInstitution: (slug: string) => getInstitution(slug) }));

import Image from "./opengraph-image";

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

describe("institution Open Graph image", () => {
  beforeEach(() => jest.clearAllMocks());

  it("names the institution and its kind over the page's summary counts", async () => {
    getInstitution.mockResolvedValue({
      institution: {
        slug: "aware-super",
        name: "Aware Super",
        kind: "super_fund",
        substantialPositions: 5,
        notices: 31,
        hasAum: true,
        aumAud: 1.9e11,
      },
      fundHoldings: [{ stockCode: "BHP" }],
    });
    const res = (await Image(params("aware-super"))) as unknown as { element: React.ReactElement };
    render(res.element);
    expect(screen.getByRole("heading")).toHaveTextContent("Aware Super");
    expect(screen.getByText("Super fund")).toBeInTheDocument();
    expect(screen.getByText(/and the holdings files it publishes/)).toBeInTheDocument();
    const stats = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(stats.slice(0, 2)).toEqual(["5 current stakes of 5%+", "31 notices read"]);
    expect(stats[2]).toMatch(/total assets \(APRA\)$/);
  });

  it("degrades to a name from the slug when the institution cannot be read", async () => {
    getInstitution.mockResolvedValue(undefined);
    const res = (await Image(params("state-street"))) as unknown as { element: React.ReactElement };
    render(res.element);
    expect(screen.getByRole("heading")).toHaveTextContent("State Street");
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("reads nothing for a slug no institution can have", async () => {
    const res = (await Image(params("Not_A_Slug"))) as unknown as { element: React.ReactElement };
    render(res.element);
    expect(getInstitution).not.toHaveBeenCalled();
  });
});
