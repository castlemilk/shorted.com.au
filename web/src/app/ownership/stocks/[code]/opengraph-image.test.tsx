import { render, screen } from "@testing-library/react";

const getStockOwnership = jest.fn();

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
    footer?: string;
  }) => (
    <div>
      <span>{eyebrow}</span>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      <p>{footer}</p>
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
jest.mock("~/app/actions/getOwnership", () => ({
  getStockOwnership: (code: string) => getStockOwnership(code),
}));

import Image, { alt } from "./opengraph-image";

const params = (code: string) => ({ params: Promise.resolve({ code }) });

const register = (summary: Record<string, unknown>, asOf = "2026-10-20") => ({
  summary: {
    stockCode: "BHP",
    companyName: "BHP Group Limited",
    holders: 2,
    disclosedPct: 11.5,
    byKind: [
      { kind: "active_manager", pct: 6.5, holders: 1 },
      { kind: "super_fund", pct: 5, holders: 1 },
    ],
    hasShortPct: true,
    shortPct: 4.21,
    ...summary,
  },
  holders: [],
  history: [],
  fundHoldings: [],
  historyTotal: 3,
  withheldListed: 0,
  asOf,
});

describe("register Open Graph image", () => {
  beforeEach(() => jest.clearAllMocks());

  it("names the register over its disclosed figures, short interest included", async () => {
    getStockOwnership.mockResolvedValue(register({}));
    const res = (await Image(params("BHP"))) as unknown as { element: React.ReactElement };
    render(res.element);

    expect(screen.getByRole("heading")).toHaveTextContent("BHP Group substantial holders");
    expect(screen.getByText("ASX:BHP register")).toBeInTheDocument();
    const stats = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(stats).toEqual([
      "11.50% disclosed, not a share",
      "2 interests counted once",
      "4.21% short interest",
    ]);
    expect(screen.getByText("ASX substantial holding notices to 2026-10-20")).toBeInTheDocument();
  });

  it("leaves out short interest when the stock has no short figure", async () => {
    getStockOwnership.mockResolvedValue(register({ hasShortPct: false }));
    const res = (await Image(params("BHP"))) as unknown as { element: React.ReactElement };
    render(res.element);

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByText(/short interest/)).toBeNull();
  });

  // A card for a failed read still draws: a social preview never shows a 500.
  it("draws the card without figures when the read fails", async () => {
    getStockOwnership.mockRejectedValue(new Error("socket hang up"));
    const res = (await Image(params("BHP"))) as unknown as { element: React.ReactElement };
    render(res.element);

    expect(screen.getByRole("heading")).toHaveTextContent("BHP substantial holders");
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("draws the card without figures when the read is undefined", async () => {
    getStockOwnership.mockResolvedValue(undefined);
    const res = (await Image(params("BHP"))) as unknown as { element: React.ReactElement };
    render(res.element);

    expect(screen.getByRole("heading")).toHaveTextContent("BHP substantial holders");
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("prints n/a for the figures no current holder supports", async () => {
    getStockOwnership.mockResolvedValue(
      register({ companyName: "Gone Co Limited", holders: 0, disclosedPct: 0, byKind: [], hasShortPct: false }),
    );
    const res = (await Image(params("GONE"))) as unknown as { element: React.ReactElement };
    render(res.element);

    const stats = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(stats).toEqual(["n/a disclosed, not a share", "n/a interests counted once"]);
    expect(stats.join(" ")).not.toMatch(/\b0\b/);
  });

  it("reads nothing for a code the path refuses, and draws the card anyway", async () => {
    const res = (await Image(params("NOT-A-CODE"))) as unknown as { element: React.ReactElement };
    render(res.element);

    expect(getStockOwnership).not.toHaveBeenCalled();
    expect(screen.getByRole("heading")).toHaveTextContent("NOT-A-CODE substantial holders");
  });

  // The alt is static, because a per-param alt needs generateImageMetadata. The
  // house copy carries no em dash; the needle is a regex literal because the
  // editorial-copy guard decodes string escapes and would read a string one as
  // the dash itself.
  it("names the register in a static alt with no em dash", () => {
    expect(alt).toBe("Substantial holders from ASX notices, on Shorted");
    expect(alt).not.toMatch(/\u2014/);
  });
});
