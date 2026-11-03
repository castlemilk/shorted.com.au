import { render, screen, within } from "@testing-library/react";
import type {
  FundHolding,
  GetStockOwnershipResponse,
  OwnershipStock,
  SubstantialHolding,
  SubstantialNotice,
} from "~/gen/shorts/v1alpha1/ownership_pb";

import { notFound } from "next/navigation";

import RegisterPage, { generateMetadata } from "./page";

const getStockOwnership = jest.fn();

jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("~/app/actions/getOwnership", () => ({
  getStockOwnership: (code: string) => getStockOwnership(code),
}));

// The register's fixtures. Each one is what the API sends, reduced to the fields
// the page reads; the summary's counts and the rows agree with each other.

interface Fixture {
  summary?: Record<string, unknown>;
  holders?: SubstantialHolding[];
  history?: SubstantialNotice[];
  funds?: FundHolding[];
  historyTotal?: number;
  withheldListed?: number;
  asOf?: string;
  sharesOnIssue?: number;
}

const stock = (over: Record<string, unknown> = {}): OwnershipStock =>
  ({
    stockCode: "BHP",
    companyName: "BHP Group Limited",
    industry: "Materials",
    holders: 0,
    disclosedPct: 0,
    byKind: [],
    shortPct: 0,
    hasShortPct: false,
    indexPct: 0,
    hasIndexPct: false,
    superOptions: 0,
    superValueAud: 0,
    hasSuperValue: false,
    marketCap: 0,
    hasMarketCap: false,
    shortAsOf: "",
    indexAsAtFrom: "",
    indexAsAtTo: "",
    indexFiles: 0,
    latestNoticeDate: "",
    ...over,
  }) as unknown as OwnershipStock;

const holder = (key: string, over: Record<string, unknown> = {}): SubstantialHolding =>
  ({
    stockCode: "BHP",
    companyName: "BHP Group Limited",
    industry: "Materials",
    holderKey: key,
    holderName: `Holder ${key}`,
    institutionSlug: "",
    kind: "active_manager",
    form: "604",
    votingPowerPct: 6.5,
    previousPct: 6,
    hasPrevious: true,
    votes: BigInt(0),
    hasVotes: false,
    eventDate: "2026-10-14",
    announcedOn: "2026-10-16",
    announcementUrl: `https://www.asx.com.au/${key}.pdf`,
    ...over,
  }) as unknown as SubstantialHolding;

const notice = (key: string, over: Record<string, unknown> = {}): SubstantialNotice =>
  ({
    stockCode: "BHP",
    companyName: "BHP Group Limited",
    holderKey: key,
    holderName: `Holder ${key}`,
    institutionSlug: "",
    kind: "active_manager",
    form: "604",
    presentPct: 6.5,
    hasPresent: true,
    previousPct: 6,
    hasPrevious: true,
    ceased: false,
    eventDate: "2026-10-14",
    announcedOn: "2026-10-16",
    announcementUrl: `https://www.asx.com.au/${key}-notice.pdf`,
    ...over,
  }) as unknown as SubstantialNotice;

const fund = (over: Record<string, unknown>): FundHolding =>
  ({
    institutionSlug: "vanguard",
    institutionName: "Vanguard",
    kind: "index_manager",
    fundName: "Vanguard Australian Shares Index Fund",
    fundCode: "VAS",
    sourceKind: "etf",
    asAt: "2026-10-19",
    stockCode: "BHP",
    companyName: "",
    units: 1e6,
    hasUnits: true,
    valueAud: 1.5e8,
    hasValue: true,
    weightPct: 3.1,
    hasWeight: true,
    pctOfIssued: 3.1,
    hasPctOfIssued: true,
    ...over,
  }) as unknown as FundHolding;

const register = ({
  summary = {},
  holders = [],
  history = [],
  funds = [],
  historyTotal,
  withheldListed = 0,
  asOf = "2026-10-20",
  sharesOnIssue = 0,
}: Fixture = {}): GetStockOwnershipResponse =>
  ({
    summary: stock({ holders: holders.length, ...summary }),
    holders,
    history,
    fundHoldings: funds,
    sharesOnIssue,
    hasSharesOnIssue: sharesOnIssue > 0,
    historyTotal: historyTotal ?? history.length,
    withheldListed,
    asOf,
  }) as unknown as GetStockOwnershipResponse;

// A stock with two current holders, one holder that ceased, a short figure, an
// index fund file and a super option. Its notices are newest first, as the API sends them.
const healthy = (over: Fixture = {}): Fixture => {
  const base: Fixture = {
    summary: {
      disclosedPct: 11.5,
      byKind: [
        { kind: "active_manager", pct: 6.5, holders: 1 },
        { kind: "super_fund", pct: 5, holders: 1 },
      ],
      hasShortPct: true,
      shortPct: 4.21,
      shortAsOf: "2026-10-19",
      hasIndexPct: true,
      indexPct: 3.1,
      indexFiles: 1,
      indexAsAtFrom: "2026-10-19",
      indexAsAtTo: "2026-10-19",
      superOptions: 1,
      hasSuperValue: true,
      superValueAud: 1.2e9,
    },
    holders: [
      holder("alpha", { holderName: "Alpha Fund", votingPowerPct: 6.5, previousPct: 6 }),
      holder("beta", { holderName: "Beta Super", kind: "super_fund", votingPowerPct: 5, hasPrevious: false, form: "603" }),
    ],
    history: [
      notice("alpha", { holderName: "Alpha Fund", presentPct: 6.5, previousPct: 6 }),
      notice("beta", { holderName: "Beta Super", kind: "super_fund", presentPct: 5, hasPrevious: false, form: "603", eventDate: "", announcedOn: "2026-09-02" }),
      notice("old", {
        holderName: "Old Holder",
        presentPct: 0,
        hasPresent: false,
        previousPct: 5.2,
        ceased: true,
        form: "605",
        eventDate: "2026-06-30",
        announcedOn: "2026-07-01",
      }),
    ],
    funds: [
      fund({}),
      fund({
        institutionSlug: "hesta",
        institutionName: "HESTA",
        kind: "super_fund",
        fundName: "Balanced",
        fundCode: "",
        sourceKind: "super_phd",
        asAt: "2026-06-30",
        valueAud: 3e7,
        weightPct: 0,
        pctOfIssued: 0.2,
      }),
    ],
    historyTotal: 3,
    sharesOnIssue: 1.6e9,
  };
  return {
    ...base,
    ...over,
    summary: { ...base.summary, ...over.summary },
  };
};

// Every holder has ceased: the register reads only cessations.
const allCeased = (): Fixture => ({
  summary: { companyName: "Gone Co Limited", stockCode: "GONE" },
  history: [
    notice("gone", {
      holderName: "Gone Holder",
      presentPct: 0,
      hasPresent: false,
      previousPct: 5.4,
      ceased: true,
      form: "605",
      eventDate: "2026-08-05",
      announcedOn: "2026-08-06",
    }),
  ],
  historyTotal: 1,
});

// One holder that became substantial and then ceased: two notices, one lane.
const ceasedPair = (): Fixture => ({
  summary: { companyName: "Pair Co Limited", stockCode: "PAIR" },
  history: [
    notice("pair", {
      holderName: "Pair Holder",
      presentPct: 0,
      hasPresent: false,
      previousPct: 5.4,
      ceased: true,
      form: "605",
      eventDate: "2026-08-05",
      announcedOn: "2026-08-06",
      announcementUrl: "https://www.asx.com.au/pair-605.pdf",
    }),
    notice("pair", {
      holderName: "Pair Holder",
      presentPct: 5.4,
      hasPresent: true,
      previousPct: 0,
      hasPrevious: false,
      ceased: false,
      form: "603",
      eventDate: "2026-06-01",
      announcedOn: "2026-06-02",
      announcementUrl: "https://www.asx.com.au/pair-603.pdf",
    }),
  ],
  historyTotal: 2,
});

const params = (code: string) => ({ params: Promise.resolve({ code }) });

const NOINDEX = { index: false, follow: true, googleBot: { index: false, follow: true } };

const figureOf = (container: HTMLElement) => container.querySelector("section[aria-labelledby='holders'] figure");
const section = (container: HTMLElement, id: string) =>
  container.querySelector(`section[aria-labelledby='${id}']`) as HTMLElement;
// The readout is the one region named "The register": the heading above it sits in a plain wrapper.
const readoutOf = (container: HTMLElement) => container.querySelector("section[aria-label='The register']") as HTMLElement;

function useFixture(fixture: Fixture) {
  getStockOwnership.mockResolvedValue(register(fixture));
}

describe("the register page's read", () => {
  beforeEach(() => jest.clearAllMocks());

  it("answers 404 for a path the code pattern refuses, before any read", async () => {
    jest.mocked(notFound).mockImplementationOnce(() => {
      throw new Error("NEXT_NOT_FOUND");
    });

    await expect(RegisterPage(params("NOT-A-CODE"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getStockOwnership).not.toHaveBeenCalled();
  });

  it("reads the register under the uppercased code", async () => {
    useFixture(healthy());
    render(await RegisterPage(params("bhp")));

    expect(getStockOwnership).toHaveBeenCalledWith("BHP");
  });

  // getStockOwnership answers undefined for a failed read. ISR caches whatever a
  // regeneration renders, so a failed read must fail the render, not answer a 404.
  it("fails the render and the metadata when the read is transiently unavailable", async () => {
    getStockOwnership.mockResolvedValue(undefined);

    await expect(RegisterPage(params("BHP"))).rejects.toThrow(/transiently unavailable/);
    await expect(generateMetadata(params("BHP"))).rejects.toThrow(/transiently unavailable/);
  });

  it("fails the render when the response carries no summary", async () => {
    getStockOwnership.mockResolvedValue({ holders: [], history: [], fundHoldings: [], historyTotal: 0 });

    await expect(RegisterPage(params("BHP"))).rejects.toThrow(/summary missing/);
  });

  it("answers 404 for a code the register knows nothing about, and noindexes its metadata", async () => {
    useFixture({ summary: { companyName: "", stockCode: "NOPE" } });
    jest.mocked(notFound).mockImplementationOnce(() => {
      throw new Error("NEXT_NOT_FOUND");
    });

    await expect(RegisterPage(params("NOPE"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(jest.mocked(notFound)).toHaveBeenCalledTimes(1);
    expect((await generateMetadata(params("NOPE"))).robots).toEqual(NOINDEX);
  });

  // The 404 is the register knowing nothing. A short figure alone is something it knows.
  it("draws a register that holds only a short figure, rather than answering 404", async () => {
    useFixture({ summary: { companyName: "", stockCode: "SHRT", hasShortPct: true, shortPct: 1.2, shortAsOf: "2026-10-19" } });
    render(await RegisterPage(params("SHRT")));

    expect(jest.mocked(notFound)).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("SHRT substantial holders");
    expect(screen.getByRole("link", { name: "Short interest →" })).toHaveAttribute("href", "/shorts/SHRT/short-interest");
    expect((await generateMetadata(params("SHRT"))).robots).toEqual(NOINDEX);
  });

  it("does not read metadata for a code the path refuses", async () => {
    const meta = await generateMetadata(params("NOT-A-CODE"));

    expect(meta.robots).toEqual(NOINDEX);
    expect(getStockOwnership).not.toHaveBeenCalled();
  });
});

describe("the register page's metadata", () => {
  beforeEach(() => jest.clearAllMocks());

  // Next merges metadata key by key: an own `robots: undefined` would replace the
  // root layout's googleBot directives with nothing, so indexable means no key.
  it("sets no robots key on a register with a current holder, and names its canonical", async () => {
    useFixture(healthy());
    const meta = await generateMetadata(params("BHP"));

    expect(Object.keys(meta)).not.toContain("robots");
    expect(meta.alternates?.canonical).toBe("https://shorted.com.au/ownership/stocks/BHP");
    // The name is cleanCompanyName's: the corporate suffix is dropped.
    expect(meta.title).toBe("BHP substantial holders: BHP Group");
    expect(meta.description).toBe(
      "BHP Group (ASX:BHP) substantial holders as their ASX notices state them: 2 interests disclosing 11.50% between them, with index fund and super option holdings and the latest 3 notices read since 2024.",
    );
  });

  it("keeps the title within 60 characters, falling back to the head term", async () => {
    useFixture(healthy({ summary: { companyName: "Australian Foundation Investment Company Limited" } }));
    const meta = await generateMetadata(params("BHP"));

    expect(meta.title).toBe("BHP substantial holders");
    expect(String(meta.title).length).toBeLessThanOrEqual(60);
  });

  it("does not repeat a code with no company name as the name", async () => {
    useFixture(healthy({ summary: { companyName: "" } }));

    expect((await generateMetadata(params("BHP"))).title).toBe("BHP substantial holders");
  });

  it("noindexes a register with no current holder, and says that no holder is read", async () => {
    useFixture(allCeased());
    const meta = await generateMetadata(params("GONE"));

    expect(meta.title).toBe("GONE substantial holders: Gone Co");
    expect(meta.robots).toEqual(NOINDEX);
    expect(meta.description).toBe("Gone Co (ASX:GONE) substantial holders as their ASX notices state them: no current holder read.");
  });
});

describe("the register page's holders", () => {
  beforeEach(() => jest.clearAllMocks());

  it("draws a lane for each current holder and for a holder that only ceased", async () => {
    useFixture(healthy());
    const { container } = render(await RegisterPage(params("BHP")));

    const lanes = within(figureOf(container) as HTMLElement).getAllByRole("listitem");
    expect(lanes).toHaveLength(3);
    expect(within(lanes[2] as HTMLElement).getByText("under 5%")).toBeInTheDocument();
    expect(screen.getByRole("figure", { name: "Substantial holders" })).toBeInTheDocument();
  });

  it("says that every holder has ceased, draws what was read, and noindexes the page", async () => {
    useFixture(allCeased());
    const { container } = render(await RegisterPage(params("GONE")));

    expect(jest.mocked(notFound)).not.toHaveBeenCalled();
    const sentence = screen.getByText(/No current substantial holder read for GONE: each holding in the 1 notice read for it has since ceased/);
    expect(sentence).toHaveClass("tabular-nums");
    expect(within(figureOf(container) as HTMLElement).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByText(/No substantial holder notices read for this stock/)).toBeNull();
    expect((await generateMetadata(params("GONE"))).robots).toEqual(NOINDEX);
  });

  // The count is the notices read, not the lines drawn: one holder, two notices.
  it("counts the notices read in the cessation sentence, not the lines drawn", async () => {
    useFixture(ceasedPair());
    const { container } = render(await RegisterPage(params("PAIR")));

    expect(screen.getByText(/each holding in the 2 notices read for it has since ceased/)).toBeInTheDocument();
    expect(within(figureOf(container) as HTMLElement).getAllByRole("listitem")).toHaveLength(1);
    expect(within(section(container, "notices")).getAllByRole("row").slice(1)).toHaveLength(2);
  });

  it("states the empty holder copy, with the method link, when no notice is read", async () => {
    useFixture({ summary: { companyName: "Quiet Co Limited", stockCode: "QUIET" } });
    const { container } = render(await RegisterPage(params("QUIET")));

    expect(jest.mocked(notFound)).not.toHaveBeenCalled();
    expect(screen.getByText(/No substantial holder notices read for this stock/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "How ownership is read →" })).toHaveAttribute("href", "/ownership#method");
    expect(figureOf(container)).toBeNull();
    const meta = await generateMetadata(params("QUIET"));
    expect(meta.robots).toEqual(NOINDEX);
    expect(meta.title).toBe("QUIET substantial holders: Quiet Co");
  });

  it("says how many notices were withheld in the figcaption and the sources, never in the plate", async () => {
    useFixture(healthy({ withheldListed: 2 }));
    const { container } = render(await RegisterPage(params("BHP")));

    const withheldLines = screen.getAllByText(/2 notices listed under BHP were withheld/);
    expect(withheldLines).toHaveLength(2);
    withheldLines.forEach((line) => expect(line).toHaveClass("tabular-nums"));
    const plate = screen.getByText(/Notices read to/).closest("p") as HTMLElement;
    expect(plate).not.toHaveTextContent(/withheld/);
    expect(figureOf(container)?.querySelector("figcaption")).toHaveTextContent(/were withheld/);
  });

  it("uses the singular for one withheld notice", async () => {
    useFixture(healthy({ withheldListed: 1 }));
    render(await RegisterPage(params("BHP")));
    expect(screen.getAllByText(/1 notice listed under BHP was withheld/)).toHaveLength(2);
  });

  it("says nothing about withheld notices when there are none", async () => {
    useFixture(healthy());
    render(await RegisterPage(params("BHP")));
    // The lanes caption says "withheld" in its own general sentence, so the count's sentence is the test.
    expect(screen.queryByText(/listed under BHP/)).toBeNull();
  });
});

describe("the register page's links and figures", () => {
  beforeEach(() => jest.clearAllMocks());

  it("links the stock pages when the stock has a short figure and a stock code", async () => {
    useFixture(healthy());
    render(await RegisterPage(params("BHP")));

    expect(screen.getByRole("link", { name: "Stock overview →" })).toHaveAttribute("href", "/shorts/BHP");
    expect(screen.getByRole("link", { name: "Company tab →" })).toHaveAttribute("href", "/shorts/BHP/company#ownership");
    expect(screen.getByRole("link", { name: "Short interest →" })).toHaveAttribute("href", "/shorts/BHP/short-interest");
  });

  // Every other stock link on the register points at the register, so the link row is the only one to a stock page.
  it("leads to no stock page except from the link row", async () => {
    useFixture(healthy());
    const { container } = render(await RegisterPage(params("BHP")));

    const stockLinks = Array.from(container.querySelectorAll("a[href^='/shorts/']")).map((a) => a.getAttribute("href"));
    expect(stockLinks).toEqual(["/shorts/BHP", "/shorts/BHP/company#ownership", "/shorts/BHP/short-interest"]);
  });

  it("draws no stock link row without a short figure, and none for a five-character code", async () => {
    useFixture(healthy({ summary: { hasShortPct: false } }));
    const { unmount } = render(await RegisterPage(params("BHP")));
    expect(screen.queryByRole("link", { name: "Stock overview →" })).toBeNull();
    unmount();

    useFixture(healthy({ summary: { companyName: "Five Co Limited" } }));
    render(await RegisterPage(params("ABCDE")));
    expect(screen.queryByRole("link", { name: "Stock overview →" })).toBeNull();
  });

  it("keeps the readout as the page's only lit surface", async () => {
    useFixture(healthy());
    const { container } = render(await RegisterPage(params("BHP")));

    const lit = container.querySelectorAll(".shadow-terminal-inset");
    expect(lit).toHaveLength(1);
    expect(lit[0]).toBe(readoutOf(container));
  });

  it("names the readout as the page's one region called The register", async () => {
    useFixture(healthy());
    render(await RegisterPage(params("BHP")));

    expect(screen.getAllByRole("region", { name: "The register" })).toHaveLength(1);
  });

  // A link to #funds lands on its heading under the sticky site header unless the heading clears it.
  it("clears the sticky site header above each section heading", async () => {
    useFixture(healthy());
    render(await RegisterPage(params("BHP")));

    for (const id of ["register", "holders", "funds", "notices", "method"]) {
      expect(document.getElementById(id)).toHaveClass("scroll-mt-20");
    }
  });

  it("prints n/a for the disclosed sum, the index share and the options when no holder is current", async () => {
    useFixture(allCeased());
    const { container } = render(await RegisterPage(params("GONE")));

    const readout = readoutOf(container);
    const values = within(readout).getAllByRole("definition").map((cell) => cell.textContent);
    expect(values[0]).toBe("n/a");
    expect(values[1]).toBe("no current holder read");
    expect(values[2]).toBe("n/a");
    expect(values[4]).toBe("n/a");
    expect(readout.querySelector(".h-2\\.5")).toBeNull();
    expect(container.querySelectorAll("symbol#ownership-external-link")).toHaveLength(1);
  });

  it("draws the readout's figures with their own dates", async () => {
    useFixture(healthy());
    const { container } = render(await RegisterPage(params("BHP")));

    const readout = readoutOf(container);
    const values = within(readout).getAllByRole("definition").map((cell) => cell.textContent);
    expect(values[0]).toBe("11.50%");
    expect(values[1]).toBe("2 interests counted once, 2 holders; not a share of the company");
    expect(values[2]).toBe("3.10%");
    expect(values[3]).toBe("1 file, as at 2026-10-19");
    expect(values[4]).toBe("1");
    expect(values[5]).toBe("$1.20B combined, as at 2026-06-30");
  });

  // The index cells read the fund rows the table draws, so a stock with no ASIC line still shows its files.
  it("counts the index fund files from the rows the table draws, not from the summary", async () => {
    useFixture(
      healthy({
        summary: { hasShortPct: false, shortPct: 0, shortAsOf: "", hasIndexPct: false, indexPct: 0, indexFiles: 0, indexAsAtFrom: "", indexAsAtTo: "" },
      }),
    );
    const { container } = render(await RegisterPage(params("BHP")));

    const values = within(readoutOf(container)).getAllByRole("definition").map((cell) => cell.textContent);
    expect(values[2]).toBe("n/a");
    expect(values[3]).toBe("1 file, as at 2026-10-19");
    expect(screen.getByText(/Notices read to/).closest("p")).toHaveTextContent("index fund files as at 2026-10-19");
    expect(section(container, "method")).toHaveTextContent("Index fund holdings files: 1 file holding BHP, as at 2026-10-19.");
  });

  it("describes its trail as a BreadcrumbList ending at the register", async () => {
    useFixture(healthy());
    const { container } = render(await RegisterPage(params("BHP")));

    const blocks = Array.from(container.querySelectorAll('script[type="application/ld+json"]')).map((s) =>
      JSON.parse(s.textContent ?? "{}"),
    );
    const trail = blocks.find((b) => b["@type"] === "BreadcrumbList");
    expect(
      trail.itemListElement.map((i: { position: number; name: string; item: string }) => [i.position, i.name, i.item]),
    ).toEqual([
      [1, "Home", "https://shorted.com.au/"],
      [2, "Ownership", "https://shorted.com.au/ownership"],
      [3, "Registers", "https://shorted.com.au/ownership/stocks"],
      [4, "BHP register", "https://shorted.com.au/ownership/stocks/BHP"],
    ]);
    const dataset = blocks.find((b) => b["@type"] === "Dataset");
    expect(dataset.name).toBe("BHP Group (BHP) substantial holders");
    expect(dataset.dateModified).toBe("2026-10-20");
  });

  // The feed's default window is 30 days, so the link asks for every notice read for the stock.
  // It is nofollow: each filtered view repeats the feed's default HTML under another canonical.
  it("links its notices heading to every notice read for the stock, as a nofollow link", async () => {
    useFixture(healthy());
    const { container } = render(await RegisterPage(params("BHP")));

    const link = screen.getByRole("link", { name: "All notices for BHP →" });
    expect(link).toHaveAttribute("href", "/ownership/notices?window=all&stock=BHP");
    expect(link).toHaveAttribute("rel", "nofollow");
    expect(section(container, "notices")).toContainElement(link);
  });

  // A register that holds fund rows and no notice has no notice for the feed to show.
  it("draws no notices link when the register holds no notice", async () => {
    useFixture({ funds: [fund({})] });
    render(await RegisterPage(params("BHP")));

    expect(screen.queryByRole("link", { name: /All notices for/ })).toBeNull();
  });
});

describe("the register page's sources and funds", () => {
  beforeEach(() => jest.clearAllMocks());

  it("lists a source only where the stock appears in it", async () => {
    useFixture(allCeased());
    const { container } = render(await RegisterPage(params("GONE")));

    const method = section(container, "method");
    expect(method).toHaveTextContent("ASX substantial holding notices (Corporations Act s671B, Forms 603, 604 and 605)");
    expect(method).not.toHaveTextContent("Index fund holdings files:");
    expect(method).not.toHaveTextContent("ASIC short position report");
    expect(method).toHaveTextContent("Who owns the ASX →");
  });

  it("draws every fund row", async () => {
    useFixture(healthy());
    const { container } = render(await RegisterPage(params("BHP")));

    expect(within(section(container, "funds")).getAllByRole("row")).toHaveLength(3);
    expect(section(container, "funds")).toHaveTextContent("VAS, Vanguard Australian Shares Index Fund");
  });

  it("says that no index fund file or super option tracks the stock", async () => {
    useFixture({ summary: { companyName: "Quiet Co Limited", stockCode: "QUIET" } });
    const { container } = render(await RegisterPage(params("QUIET")));

    expect(section(container, "funds")).toHaveTextContent(
      "No index fund file or super option disclosure tracked holds QUIET.",
    );
  });

  it("draws the newest 25 notices, and says how many the register holds", async () => {
    const history = Array.from({ length: 30 }, (_, i) =>
      notice(`n${i}`, { announcedOn: `2026-10-${String(20 - (i % 20)).padStart(2, "0")}` }),
    );
    useFixture(healthy({ history, historyTotal: 120 }));
    const { container } = render(await RegisterPage(params("BHP")));

    expect(screen.getByText("The latest 30 of 120 notices read for BHP.")).toHaveClass("tabular-nums");
    expect(section(container, "notices")).toHaveTextContent("The latest 30 of 120 notices read for BHP.");
    const table = screen.getByRole("table", { name: "BHP's substantial holding notices" });
    expect(within(table).getAllByRole("row").slice(1)).toHaveLength(25);
  });
});
