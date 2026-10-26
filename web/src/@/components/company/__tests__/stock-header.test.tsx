import fs from "node:fs";
import path from "node:path";
import {
  Suspense,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { type Stock, type StockDetails } from "~/gen/stocks/v1alpha1/stocks_pb";

const mockGetStockDetails = jest.fn();
jest.mock("~/app/actions/getStockDetails", () => ({
  getStockDetails: (...args: unknown[]) => mockGetStockDetails(...args),
}));
// The shared jest setup stubs lib/utils down to `cn`. The header also formats
// numbers with it, and the real `cn` shows the classes production emits.
jest.mock("~/@/lib/utils", () => jest.requireActual("~/@/lib/utils"));

import {
  StockHeader,
  StockHeaderLogo,
  type StockHeaderProps,
} from "../stock-header";

const BHP = {
  productCode: "BHP",
  name: "BHP GROUP LIMITED ORDINARY",
  industry: "Materials",
  percentageShorted: 1.58,
  reportedShortPositions: 80_123_456,
  totalProductInIssue: 5_060_000_000,
} as Stock;

// The 6th of October in Sydney, and still the 5th in UTC, so a header that formats
// the date in the server's zone shows the wrong day.
const AS_OF = new Date("2026-10-05T13:00:00Z");

// The sign of a fall and the glyph for no change. Escapes, because both look like a hyphen.
const MINUS = "\u2212";
const FLAT = "\u2013";

const props = (overrides: Partial<StockHeaderProps> = {}): StockHeaderProps => ({
  stockCode: "BHP",
  stock: BHP,
  change30d: 0.5,
  asOf: AS_OF,
  ...overrides,
});

const details = (overrides: Partial<StockDetails> = {}) =>
  ({
    productCode: "BHP",
    companyName: "BHP Group Limited",
    gcsUrl: "https://logos.example/bhp-raw.png",
    logoIconGcsUrl: "",
    enrichmentStatus: "",
    ...overrides,
  }) as StockDetails;

/**
 * react-dom 18 cannot render an async server component, and the header holds
 * one: the logo, under Suspense. Render the header the way the server would:
 * call it, await each StockHeaderLogo in what it returns, and put that output
 * where the element was. The boundary, the fixed box and every class stay real.
 */
async function renderHeader(p: StockHeaderProps = props()) {
  const settle = async (node: ReactNode): Promise<ReactNode> => {
    if (Array.isArray(node)) return Promise.all(node.map(settle));
    if (!isValidElement(node)) return node;
    const element = node as ReactElement<{ children?: ReactNode }>;
    if (element.type === StockHeaderLogo) {
      return settle(await StockHeaderLogo(element.props as { stockCode: string }));
    }
    const { children } = element.props;
    if (children === undefined) return element;
    const settled = await settle(children);
    return cloneElement(element, undefined, ...(Array.isArray(settled) ? settled : [settled]));
  };
  return render(<>{await settle(StockHeader(p))}</>);
}

/** The first element in a tree of elements that `match` accepts. */
function find(
  node: ReactNode,
  match: (element: ReactElement<{ children?: ReactNode; className?: string }>) => boolean,
): ReactElement<{ children?: ReactNode; className?: string; fallback?: ReactNode }> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, match);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const element = node as ReactElement<{ children?: ReactNode; className?: string }>;
  return match(element) ? element : find(element.props.children, match);
}

/** The `<dd>`s that belong to a label, in order. */
function figuresOf(label: string): HTMLElement[] {
  const group = screen.getByText(label, { selector: "dt" }).parentElement as HTMLElement;
  return Array.from(group.querySelectorAll("dd"));
}

beforeEach(() => {
  mockGetStockDetails.mockReset();
  mockGetStockDetails.mockResolvedValue(details());
});

describe("StockHeader identity", () => {
  it("names the company in an h2 that labels the section, with the full name as its title", async () => {
    const { container } = await renderHeader();
    const heading = screen.getByRole("heading", { level: 2, name: "BHP Group" });
    expect(heading).toHaveAttribute("title", "BHP Group");
    expect(heading).toHaveClass(
      "font-mono", "text-lg", "font-bold", "leading-tight", "line-clamp-2", "sm:line-clamp-1", "sm:text-xl",
    );
    const section = container.querySelector("section")!;
    expect(heading.id).not.toBe("");
    expect(section).toHaveAttribute("aria-labelledby", heading.id);
  });

  it("repairs the ASIC name's shouted case, as the page's other headings do", async () => {
    await renderHeader(props({ stockCode: "CSL", stock: { ...BHP, name: "CSL LIMITED ORDINARY" } as Stock }));
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("CSL");
  });

  it("falls back to the code when the stock has no name", async () => {
    await renderHeader(props({ stock: { ...BHP, name: "" } as Stock }));
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/^BHP$/);
  });

  it("shows the code in semibold mono beside the industry badge", async () => {
    await renderHeader();
    const code = screen.getByText("BHP", { selector: "span" });
    expect(code).toHaveClass("font-mono", "font-semibold");
    const badge = screen.getByText("Materials");
    expect(badge).toBeInTheDocument();
    expect(badge.closest("[title]")).toHaveAttribute("title", "Materials");
    expect(code.parentElement).toContainElement(badge);
  });

  it("leaves the badge out when the industry is empty, and keeps the code", async () => {
    await renderHeader(props({ stock: { ...BHP, industry: "" } as Stock }));
    const code = screen.getByText("BHP", { selector: "span" });
    // The code is all the line holds: no empty badge sits beside it.
    expect(code.parentElement?.children).toHaveLength(1);
  });

  // The ASX's placeholders for a security with no industry (an ETF, a trust) or
  // one still to be classified, and "Other", the bucket they are gathered in.
  it.each([
    "Not Applic",
    "Not Applicable",
    "NOT APPLIC",
    "not applicable",
    "  Not Applic  ",
    "Not Applicable\n",
    "Class Pend",
    "Other",
  ])(
    "leaves the badge out for the placeholder industry %p, as for an empty one",
    async (industry) => {
      const { container } = await renderHeader(props({ stock: { ...BHP, industry } as Stock }));
      const code = screen.getByText("BHP", { selector: "span" });
      expect(code.parentElement?.children).toHaveLength(1);
      // Neither as text nor as a title attribute.
      expect(container.innerHTML).not.toMatch(new RegExp(industry.trim(), "i"));
    },
  );

  it("badges a real industry whose name only starts like the placeholder, trimmed", async () => {
    await renderHeader(props({ stock: { ...BHP, industry: "  Applications Software " } as Stock }));
    expect(screen.getByText("Applications Software")).toBeInTheDocument();
    expect(screen.getByText("Applications Software").closest("[title]")).toHaveAttribute("title", "Applications Software");
    cleanup();
    await renderHeader(props({ stock: { ...BHP, industry: "Not Applic Holdings" } as Stock }));
    expect(screen.getByText("Not Applic Holdings")).toBeInTheDocument();
  });

  it("truncates a long industry rather than letting it push the row wider", async () => {
    await renderHeader(
      props({ stock: { ...BHP, industry: "Pharmaceuticals, Biotechnology & Life Sciences" } as Stock }),
    );
    const industry = screen.getByText("Pharmaceuticals, Biotechnology & Life Sciences");
    expect(industry).toHaveClass("truncate");
    expect(industry.parentElement).toHaveClass("min-w-0");
  });
});

describe("StockHeader readout", () => {
  it("shows the short percentage to two decimals, large, in tabular mono", async () => {
    await renderHeader(props({ stock: { ...BHP, percentageShorted: 1.5 } as Stock }));
    const [value] = figuresOf("Short interest");
    expect(value).toHaveTextContent("1.50%");
    expect(value).toHaveClass("font-mono", "text-2xl", "font-bold", "tabular-nums");
  });

  it("puts a tiny percentage under 0.01%, never at 0.00%, a bare 0 or a dash", async () => {
    await renderHeader(props({ stock: { ...BHP, percentageShorted: 0.004 } as Stock }));
    expect(figuresOf("Short interest")[0]).toHaveTextContent(/^<0\.01%$/);
  });

  // ANT, 164 shares short, read "0.00%", a measured zero for a reported
  // position (the page's one rule, ~/@/lib/stocks/short-percent).
  it("never prints a reported position as 0.00%", async () => {
    await renderHeader(props({ stock: { ...BHP, percentageShorted: 0.0000205 } as Stock }));
    expect(figuresOf("Short interest")[0]).toHaveTextContent(/^<0\.01%$/);
  });

  it("formats the reported shorts and the shares on issue", async () => {
    await renderHeader();
    expect(figuresOf("Reported shorts")).toHaveLength(1);
    expect(figuresOf("Reported shorts")[0]).toHaveTextContent("80.1M");
    expect(figuresOf("Shares on issue")[0]).toHaveTextContent("5.060B");
    expect(figuresOf("Reported shorts")[0]).toHaveClass("tabular-nums");
    expect(figuresOf("Shares on issue")[0]).toHaveClass("tabular-nums");
  });

  it("labels the three figures in uppercase mono, muted", async () => {
    await renderHeader();
    for (const label of ["Short interest", "Reported shorts", "Shares on issue"]) {
      const dt = screen.getByText(label, { selector: "dt" });
      expect(dt).toHaveClass("font-mono", "uppercase", "text-muted-foreground");
      expect(dt.className).toMatch(/text-\[1[01]px\]/);
    }
  });

  it("is a description list of three groups", async () => {
    const { container } = await renderHeader();
    const list = container.querySelector("dl")!;
    expect(list.querySelectorAll("dt")).toHaveLength(3);
    expect(Array.from(list.children).every((group) => group.tagName === "DIV")).toBe(true);
  });

  it("never prints undefined, NaN or a placeholder dash for a missing figure", async () => {
    const { container } = await renderHeader(
      props({ stock: { productCode: "BHP" } as Stock, change30d: null, asOf: null }),
    );
    expect(container.textContent).not.toMatch(/undefined|NaN|null|\u2014/);
  });
});

// The API sends a figure it does not hold as 0 (a proto3 number has no unset),
// and a 0 in this readout is a claim: no short positions, no shares. So a figure
// it does not hold is left out, never printed as 0.
describe("StockHeader a figure the API does not hold", () => {
  const withFigures = (figures: Partial<Record<"percentageShorted" | "reportedShortPositions" | "totalProductInIssue", number | undefined>>) =>
    props({ stock: { ...BHP, ...figures } as Stock });
  const labels = () => Array.from(document.querySelectorAll("dt")).map((dt) => dt.textContent);

  it.each([[0], [undefined], [Number.NaN], [-5]])(
    "leaves 'Shares on issue' out when it is %p, rather than printing 0",
    async (totalProductInIssue) => {
      const { container } = await renderHeader(withFigures({ totalProductInIssue }));
      expect(labels()).toEqual(["Short interest", "Reported shorts"]);
      expect(screen.queryByText("Shares on issue")).toBeNull();
      // The short interest percentage is the readout's one headline: it stays.
      expect(figuresOf("Short interest")[0]).toHaveTextContent("1.58%");
      expect(container.querySelectorAll("dl > div")).toHaveLength(2);
    },
  );

  it.each([[0], [undefined], [Number.NaN]])(
    "leaves 'Reported shorts' out when it is %p and the short percentage is not 0",
    async (reportedShortPositions) => {
      await renderHeader(withFigures({ reportedShortPositions }));
      expect(labels()).toEqual(["Short interest", "Shares on issue"]);
      expect(screen.queryByText("Reported shorts")).toBeNull();
    },
  );

  it.each([[0], [undefined]])(
    "prints 0 reported shorts when the short percentage is itself 0, a true zero (%p)",
    async (reportedShortPositions) => {
      await renderHeader(withFigures({ percentageShorted: 0, reportedShortPositions }));
      expect(figuresOf("Short interest")[0]).toHaveTextContent("0.00%");
      expect(figuresOf("Reported shorts")[0]).toHaveTextContent(/^0$/);
    },
  );

  it("does not take an unset percentage for a true zero", async () => {
    await renderHeader(withFigures({ percentageShorted: undefined, reportedShortPositions: 0 }));
    expect(screen.queryByText("Reported shorts")).toBeNull();
  });

  it("prints a count that is there, whatever the percentage", async () => {
    await renderHeader(withFigures({ percentageShorted: 0.004, reportedShortPositions: 12_000 }));
    expect(figuresOf("Reported shorts")[0]).toHaveTextContent("12K");
  });

  it("is left with the short interest group alone when the API holds neither figure", async () => {
    const { container } = await renderHeader(
      withFigures({ reportedShortPositions: 0, totalProductInIssue: 0 }),
    );
    expect(labels()).toEqual(["Short interest"]);
    expect(container.querySelectorAll("dl > div")).toHaveLength(1);
    expect(container.textContent).not.toMatch(/Reported shorts|Shares on issue|undefined|NaN/);
  });

  it("still prints both when the API holds both", async () => {
    await renderHeader();
    expect(labels()).toEqual(["Short interest", "Reported shorts", "Shares on issue"]);
  });
});

describe("StockHeader 30-day change", () => {
  it("says a rise with an up arrow, a plus and the magnitude in pp", async () => {
    await renderHeader(props({ change30d: 0.5 }));
    const change = screen.getByText("+0.50 pp 30d");
    expect(change).toHaveTextContent("▲ +0.50 pp 30d");
    // Under the percentage it describes.
    expect(figuresOf("Short interest")[1]).toBe(change);
  });

  it("says a fall with a down arrow and a true minus (U+2212), never a hyphen", async () => {
    await renderHeader(props({ change30d: -0.31 }));
    const change = screen.getByText(`${MINUS}0.31 pp 30d`);
    expect(change).toHaveTextContent(`▼ ${MINUS}0.31 pp 30d`);
    expect(change.textContent).not.toContain("-");
  });

  it("says no change with a dash, and no sign", async () => {
    await renderHeader(props({ change30d: 0 }));
    expect(screen.getByText("0.00 pp 30d")).toHaveTextContent(`${FLAT} 0.00 pp 30d`);
  });

  it.each([0.004, -0.004, -0])(
    "calls %p flat, because the digits it prints say 0.00 and so should the arrow",
    async (change30d) => {
      await renderHeader(props({ change30d }));
      expect(screen.getByText("0.00 pp 30d")).toHaveTextContent(`${FLAT} 0.00 pp 30d`);
    },
  );

  it("rounds before it picks the arrow and the sign", async () => {
    await renderHeader(props({ change30d: 0.005 }));
    expect(screen.getByText("+0.01 pp 30d")).toHaveTextContent("▲ +0.01 pp 30d");
  });

  it("explains pp and 30d in a tooltip, and where the report date comes from", async () => {
    await renderHeader();
    expect(screen.getByText("+0.50 pp 30d")).toHaveAttribute(
      "title",
      expect.stringMatching(/30 days.*percentage points/),
    );
    expect(screen.getByText("as of 6 Oct 2026")).toHaveAttribute("title", expect.stringMatching(/ASIC.*T\+4/));
  });

  it("leaves the arrow to the eye and the sign to a screen reader", async () => {
    await renderHeader(props({ change30d: -2 }));
    const arrow = screen.getByText("▼");
    expect(arrow).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText(`${MINUS}2.00 pp 30d`)).not.toHaveAttribute("aria-hidden");
  });

  it("is left out when unknown", async () => {
    await renderHeader(props({ change30d: null }));
    expect(screen.queryByText(/pp\b/)).toBeNull();
    expect(screen.queryByText(/30d/)).toBeNull();
    expect(screen.queryByText(/[▲▼]/)).toBeNull();
    // The rest of the readout is still there.
    expect(figuresOf("Short interest")).toHaveLength(2); // the percentage and the report date
  });

  it("is left out when it is not a number", async () => {
    await renderHeader(props({ change30d: Number.NaN }));
    expect(screen.queryByText(/pp\b/)).toBeNull();
  });

  it.each([
    [2.5, "text-red-600", "a rise in short interest is red"],
    [0.005, "text-red-600", "a rise that rounds up is red, as its arrow is up"],
    [-2.5, "text-green-700", "a fall is green"],
    [0, "text-foreground", "no change is the foreground"],
    [0.004, "text-foreground", "a change that rounds to 0.00 is the foreground, as its arrow is flat"],
  ])("colours %p %s: %s", async (change30d, tone) => {
    const { container } = await renderHeader(props({ change30d }));
    const change = figuresOf("Short interest")[1]!;
    expect(change).toHaveClass(tone);
    for (const other of ["text-red-600", "text-green-700", "text-foreground"].filter((c) => c !== tone)) {
      expect(change).not.toHaveClass(other);
    }
    // The change is the only coloured figure: the direction of a short position
    // colours nothing else in the header.
    change.remove();
    expect(container.innerHTML).not.toMatch(/text-(red|green|amber)|bg-(red|green)/);
  });

  it.each([
    [1, "dark:text-red-400"],
    [-1, "dark:text-green-400"],
  ])("gives %p its dark-mode shade, %s", async (change30d, shade) => {
    await renderHeader(props({ change30d }));
    expect(figuresOf("Short interest")[1]).toHaveClass(shade);
  });
});

describe("StockHeader report date", () => {
  it("is the Sydney calendar day of the ASIC report, whatever zone the server runs in", async () => {
    await renderHeader(props({ asOf: AS_OF }));
    expect(screen.getByText("as of 6 Oct 2026")).toBeInTheDocument();
  });

  it("is left out when unknown", async () => {
    await renderHeader(props({ asOf: null }));
    expect(screen.queryByText(/as of/)).toBeNull();
  });
});

describe("StockHeader surface", () => {
  it("is the page's one lit surface: exactly one element carries shadow-terminal-inset, and nothing else glows", async () => {
    const { container } = await renderHeader();
    const lit = container.querySelectorAll(".shadow-terminal-inset");
    expect(lit).toHaveLength(1);
    expect(lit[0]).toBe(container.querySelector("section"));
    const glows = Array.from(container.querySelectorAll("[class]"))
      .flatMap((element) => Array.from(element.classList))
      .filter((name) => /shadow|glow/.test(name));
    expect(glows).toEqual(["shadow-terminal-inset"]);
  });

  it("is a bordered card with the chrome's 16px spacing and tight padding", async () => {
    const { container } = await renderHeader();
    expect(container.querySelector("section")).toHaveClass("mb-4", "rounded-lg", "border", "bg-card", "px-4", "py-3");
  });

  it("stacks the identity above the readout on a phone and puts them in one row from sm", async () => {
    const { container } = await renderHeader();
    expect(container.querySelector("section")).toHaveClass("flex", "flex-col", "sm:flex-row", "sm:items-center");
  });
});

describe("StockHeader logo box", () => {
  it("is a fixed box, 40px on a phone and 48px from sm, that the logo cannot resize", async () => {
    await renderHeader();
    const logo = screen.getByAltText("BHP Group Limited logo");
    expect(logo.closest(".relative")).toHaveClass("relative", "h-10", "w-10", "shrink-0", "sm:h-12", "sm:w-12");
  });

  it("holds a placeholder of the same box while the logo loads, and reads nothing until then", () => {
    const tree = StockHeader(props());
    const box = find(tree, (el) => /\bh-10 w-10\b/.test(el.props.className ?? ""))!;
    expect(box.props.className).toBe("relative h-10 w-10 shrink-0 sm:h-12 sm:w-12");

    const boundary = box.props.children as ReactElement<{ children: ReactElement; fallback: ReactNode }>;
    expect(boundary.type).toBe(Suspense);
    expect(boundary.props.children.type).toBe(StockHeaderLogo);
    expect(boundary.props.children.props).toEqual({ stockCode: "BHP" });

    const { container } = render(<>{boundary.props.fallback}</>);
    expect(container.firstElementChild).toHaveClass("h-full", "w-full");
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(mockGetStockDetails).not.toHaveBeenCalled();
  });

  it("is where the logo lands, and the sparkle sits at its corner when the company is enriched", async () => {
    mockGetStockDetails.mockResolvedValue(details({ enrichmentStatus: "completed" }));
    await renderHeader();
    const box = screen.getByAltText("BHP Group Limited logo").closest(".relative")!;
    const sparkle = within(box as HTMLElement).getByRole("img", { name: "AI-enhanced data available" });
    expect(sparkle).toBeInTheDocument();
  });
});

describe("StockHeaderLogo", () => {
  it("reads the details for its code", async () => {
    render(await StockHeaderLogo({ stockCode: "BHP" }));
    expect(mockGetStockDetails).toHaveBeenCalledTimes(1);
    expect(mockGetStockDetails).toHaveBeenCalledWith("BHP");
  });

  it("draws the logo filling its box, 48px at most, never stretched", async () => {
    const { container } = render(await StockHeaderLogo({ stockCode: "BHP" }));
    const logo = screen.getByAltText("BHP Group Limited logo");
    expect(logo.tagName).toBe("IMG");
    expect(logo).toHaveAttribute("width", "48");
    expect(logo).toHaveAttribute("height", "48");
    // CompanyLogo sizes the image with an inline style, which only !important beats.
    expect(logo).toHaveClass("!h-full", "!w-full", "object-contain");
    expect(container.firstElementChild).toHaveClass("h-full", "w-full");
  });

  it("falls to the details' icon url, then to the logo url, once the normalized logo fails", async () => {
    mockGetStockDetails.mockResolvedValue(details({ logoIconGcsUrl: "https://logos.example/bhp-icon.png" }));
    const first = render(await StockHeaderLogo({ stockCode: "BHP" }));
    fireEvent.error(screen.getByAltText("BHP Group Limited logo"));
    expect(screen.getByAltText("BHP Group Limited logo")).toHaveAttribute("src", "https://logos.example/bhp-icon.png");
    first.unmount();

    mockGetStockDetails.mockResolvedValue(details({ logoIconGcsUrl: "" }));
    render(await StockHeaderLogo({ stockCode: "BHP" }));
    fireEvent.error(screen.getByAltText("BHP Group Limited logo"));
    expect(screen.getByAltText("BHP Group Limited logo")).toHaveAttribute("src", "https://logos.example/bhp-raw.png");
  });

  it("names the logo by the company, or by the code when the details give no name", async () => {
    mockGetStockDetails.mockResolvedValue(details({ companyName: "" }));
    render(await StockHeaderLogo({ stockCode: "BHP" }));
    expect(screen.getByAltText("BHP logo")).toBeInTheDocument();
  });

  it("falls to the logo bucket's own copy when the details name no logo url at all", async () => {
    mockGetStockDetails.mockResolvedValue(details({ logoIconGcsUrl: "", gcsUrl: "" }));
    render(await StockHeaderLogo({ stockCode: "BHP" }));
    fireEvent.error(screen.getByAltText("BHP Group Limited logo"));
    expect(screen.getByAltText("BHP Group Limited logo").getAttribute("src")).toContain("/logos/BHP.png");
  });

  it("adds the sparkle badge, 14px, only when the company's data is enriched", async () => {
    mockGetStockDetails.mockResolvedValue(details({ enrichmentStatus: "completed" }));
    const enriched = render(await StockHeaderLogo({ stockCode: "BHP" }));
    const sparkle = screen.getByRole("img", { name: "AI-enhanced data available" });
    expect(sparkle).toHaveClass("absolute", "h-3.5", "w-3.5");
    expect(sparkle).toHaveAttribute("title", "AI-enhanced data available");
    enriched.unmount();

    for (const enrichmentStatus of ["", "pending", "failed"]) {
      mockGetStockDetails.mockResolvedValue(details({ enrichmentStatus }));
      const plain = render(await StockHeaderLogo({ stockCode: "BHP" }));
      expect(screen.queryByRole("img", { name: "AI-enhanced data available" })).toBeNull();
      plain.unmount();
    }
  });

  // The details read returns undefined for every failure (withRetryAndNotFound),
  // and a caller that gets a rejection must not lose the logo either.
  describe.each([
    ["no details (undefined)", () => mockGetStockDetails.mockResolvedValue(undefined)],
    ["null details", () => mockGetStockDetails.mockResolvedValue(null)],
    ["a failed read", () => mockGetStockDetails.mockRejectedValue(new Error("unavailable"))],
  ])("with %s", (_name, arrange) => {
    beforeEach(arrange);

    it("still draws the logo, found by the code, in the same box classes, with no sparkle", async () => {
      const { container } = render(await StockHeaderLogo({ stockCode: "BHP" }));
      const logo = screen.getByAltText("BHP logo");
      expect(logo.getAttribute("src")).toContain("/logos-normalized/BHP.png");
      expect(logo).toHaveClass("!h-full", "!w-full", "object-contain");
      expect(container.firstElementChild).toHaveClass("h-full", "w-full");
      expect(screen.queryByRole("img", { name: "AI-enhanced data available" })).toBeNull();
    });

    it("ends on CompanyLogo's own icon when no logo loads, filling the same box", async () => {
      const { container } = render(await StockHeaderLogo({ stockCode: "BHP" }));
      fireEvent.error(screen.getByAltText("BHP logo")); // the normalized logo
      fireEvent.error(screen.getByAltText("BHP logo")); // the raw one
      expect(screen.queryByRole("img")).toBeNull();
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper).toHaveClass("h-full", "w-full", "[&_svg]:h-full", "[&_svg]:w-full");
      expect(wrapper.querySelector("svg")).not.toBeNull();
    });
  });
});

// A server component renders this, so the file must stay one a server bundle
// can take: no client directive, and no client twin or Connect client behind a
// static import of its own. (The cached details read is the one module it
// reaches that talks to the API, and it is a server module.)
describe("stock-header.tsx is server-safe", () => {
  const source = fs.readFileSync(path.join(__dirname, "../stock-header.tsx"), "utf8");
  const importSpecifiers = Array.from(
    source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm),
    (m) => m[1],
  );

  it('has no "use client" directive', () => {
    expect(source).not.toMatch(/^\s*["']use client["']/m);
  });

  it("imports nothing from Connect, and no retry twin of a server component", () => {
    expect(importSpecifiers.length).toBeGreaterThan(0);
    for (const specifier of importSpecifiers) {
      expect(specifier).not.toMatch(/connectrpc|bufbuild\/connect|with-retry|actions\/client\//);
    }
  });

  it("reads the company details through the cached server action", () => {
    expect(importSpecifiers).toContain("~/app/actions/getStockDetails");
  });
});
