/**
 * The compare island renders two NAMED parliamentarians beside each other,
 * which is the single most imputation-prone thing the influence layer does.
 *
 * So these assertions are not mostly about React. They are about the things
 * that would be defensible to lose in review and indefensible to publish:
 *
 *   - no ranking vocabulary anywhere a reader can see it,
 *   - two colours that a reader can tell apart WITHOUT the page telling them
 *     one side is good and the other bad (never a red/green pair), and where
 *     both sides share a party, a stated mapping rather than an inferred one,
 *   - an empty or one-sided selection is an invitation, never an error,
 *   - the coverage caveat, because two members' registers are not read to the
 *     same depth and a difference in a count can be a difference in what we
 *     extracted rather than in what was declared.
 *
 * The panel lives under app/politicians/compare rather than in this component
 * tree because it reaches the protobuf runtime; see its own docblock. Its tests
 * live here so `npx jest src/@/components/politicians` covers the whole
 * politician surface in one command.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ComparePanel } from "~/app/politicians/compare/compare-panel";
import { partyColorFromAb } from "@/lib/politics/party-palette";
import type { PoliticianHit } from "@/lib/politics/politician-search";

const replace = jest.fn();
let searchParams = new URLSearchParams();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: (...args: unknown[]) => replace(...args), push: jest.fn() }),
  useSearchParams: () => searchParams,
}));

const searchPoliticians = jest.fn();
jest.mock("@/lib/politics/politician-search", () => ({
  searchPoliticians: (...args: unknown[]) => searchPoliticians(...args),
}));

const comparePoliticians = jest.fn();
// Replaced WHOLESALE, with no requireActual: the real module pulls
// @connectrpc/connect-web and the generated descriptors in behind it, and the
// island under test never needs either.
jest.mock("~/app/actions/client/getPoliticiansClient", () => ({
  comparePoliticiansClient: (...args: unknown[]) => comparePoliticians(...args),
}));

/* ------------------------------------------------------------------ fixtures */

function member(overrides: Record<string, unknown>) {
  return {
    slug: "a-member",
    displayName: "A Member",
    surname: "Member",
    givenNames: "A",
    honorific: "",
    chamber: "house",
    division: "Example",
    stateCode: "NSW",
    party: "",
    partyAb: "ALP",
    firstParliament: 46,
    lastParliament: 48,
    aphMpid: "",
    declaredListedCount: 4,
    declaredPropertyCount: 2,
    photoUrl: "",
    photoLicence: "",
    photoAuthor: "",
    photoSourceUrl: "",
    ...overrides,
  };
}

function summary(overrides: Record<string, unknown>) {
  return {
    politician: member({}),
    itemCounts: [
      { itemNo: 1, itemLabel: "Shareholdings", currentCount: 6, politicianCount: 1, allTimeCount: 8 },
      { itemNo: 3, itemLabel: "Real estate", currentCount: 2, politicianCount: 1, allTimeCount: 3 },
      { itemNo: 6, itemLabel: "Liabilities", currentCount: 1, politicianCount: 1, allTimeCount: 1 },
      { itemNo: 11, itemLabel: "Gifts", currentCount: 3, politicianCount: 1, allTimeCount: 3 },
    ],
    distinctCompanyCount: 4,
    propertyCount: 2,
    giftsTravelCount: 3,
    liabilityCount: 1,
    changes90d: 2,
    trend: [],
    undatedCount: 5,
    ...overrides,
  };
}

/** Both sides, different parties, with shared and one-sided companies. */
function compareResponse(overrides: Record<string, unknown> = {}) {
  return {
    a: summary({ politician: member({}) }),
    b: summary({
      politician: member({
        slug: "b-member",
        displayName: "B Member",
        chamber: "senate",
        division: "",
        stateCode: "VIC",
        partyAb: "LP",
      }),
      itemCounts: [
        { itemNo: 1, itemLabel: "Shareholdings", currentCount: 2, politicianCount: 1, allTimeCount: 2 },
        { itemNo: 3, itemLabel: "Real estate", currentCount: 4, politicianCount: 1, allTimeCount: 4 },
      ],
      distinctCompanyCount: 2,
      propertyCount: 4,
      giftsTravelCount: 0,
      liabilityCount: 0,
      changes90d: 0,
      undatedCount: 1,
    }),
    holderCountsA: [
      { holder: 1, currentCount: 8 },
      { holder: 2, currentCount: 4 },
    ],
    holderCountsB: [
      { holder: 1, currentCount: 6 },
      { holder: 0, currentCount: 2 },
    ],
    sharedCompanies: [
      {
        stockCode: "BHP",
        companyName: "BHP Group",
        industry: "Materials",
        holdersA: [1],
        holdersB: [2],
        currentlyDeclaredA: true,
        currentlyDeclaredB: false,
      },
    ],
    onlyACompanies: Array.from({ length: 10 }, (_, i) => ({
      stockCode: `AA${i}`,
      companyName: `Company ${i}`,
      industry: "Financials",
      holders: [1],
      currentlyDeclared: true,
    })),
    onlyBCompanies: [
      {
        stockCode: "CSL",
        companyName: "CSL Limited",
        industry: "Health Care",
        holders: [1],
        currentlyDeclared: true,
      },
    ],
    onlyAMore: 3,
    onlyBMore: 0,
    extractedParliamentsA: [47, 48],
    partialParliamentsA: [46],
    pendingParliamentsA: [44, 45],
    extractedParliamentsB: [48],
    partialParliamentsB: [],
    pendingParliamentsB: [44, 45, 46, 47],
    asAt: { $typeName: "google.protobuf.Timestamp", seconds: BigInt(1753920000), nanos: 0 },
    sourceLicence: "CC BY-NC-ND 4.0",
    ...overrides,
  };
}

const HIT: PoliticianHit = {
  objectID: "b-member",
  slug: "b-member",
  display_name: "B Member",
  chamber: "senate",
  state_code: "VIC",
  party_ab: "LP",
  declared_listed_count: 2,
  declared_property_count: 4,
};

function mockSearch(hits: PoliticianHit[]) {
  searchPoliticians.mockResolvedValue({
    hits,
    nbHits: hits.length,
    page: 0,
    nbPages: 1,
    hitsPerPage: 6,
    processingTimeMS: 1,
    query: "",
  });
}

/** Every colour the paired bars actually painted, as jsdom reports it. */
function barColors(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-compare-bar]")).map(
    (el) => (el as HTMLElement).style.backgroundColor,
  );
}

function rgb(hex: string): string {
  const value = hex.replace("#", "");
  const n = parseInt(value, 16);
  // eslint-disable-next-line no-bitwise
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

beforeEach(() => {
  replace.mockReset();
  searchPoliticians.mockReset();
  comparePoliticians.mockReset();
  searchParams = new URLSearchParams();
  mockSearch([HIT]);
});

/* ------------------------------------------------------------------- states */

describe("compare panel — selection states", () => {
  it("invites a selection instead of reporting an error when nothing is chosen", async () => {
    render(<ComparePanel />);
    expect(
      screen.getByText(/Choose two parliamentarians/i),
    ).toBeInTheDocument();
    // And it says up front what the counts are and are not.
    expect(screen.getByText(/no quantity and no value/i)).toBeInTheDocument();
    expect(comparePoliticians).not.toHaveBeenCalled();
  });

  it("keeps inviting when only one side is chosen", async () => {
    searchParams = new URLSearchParams("a=a-member");
    render(<ComparePanel />);
    expect(screen.getByText(/Choose two parliamentarians/i)).toBeInTheDocument();
    expect(comparePoliticians).not.toHaveBeenCalled();
  });

  it("states the same-member case in its own words and never asks the API", async () => {
    // The backend rejects slug_a == slug_b with InvalidArgument, which is
    // terminal for the retry helper — so a request would surface as "could not
    // be loaded" for what is really "you picked one person twice".
    searchParams = new URLSearchParams("a=a-member&b=a-member");
    render(<ComparePanel />);
    expect(
      screen.getByText(/Both fields name the same member/i),
    ).toBeInTheDocument();
    expect(comparePoliticians).not.toHaveBeenCalled();
  });

  it("degrades without claiming anything is missing from the register", async () => {
    searchParams = new URLSearchParams("a=a-member&b=b-member");
    comparePoliticians.mockResolvedValue(undefined);
    render(<ComparePanel />);
    await waitFor(() =>
      expect(
        screen.getByText(/Nothing is missing from the register/i),
      ).toBeInTheDocument(),
    );
  });
});

/* ------------------------------------------------------------------ pickers */

describe("compare panel — pickers and URL", () => {
  it("mirrors the selection into the URL without pushing history", async () => {
    searchParams = new URLSearchParams("a=a-member&b=b-member");
    comparePoliticians.mockResolvedValue(compareResponse());
    render(<ComparePanel />);
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        "/politicians/compare?a=a-member&b=b-member",
        { scroll: false },
      ),
    );
  });

  it("searches on focus and compares once a second member is picked", async () => {
    searchParams = new URLSearchParams("a=a-member");
    comparePoliticians.mockResolvedValue(compareResponse());
    render(<ComparePanel />);

    const input = screen.getByLabelText("Second member");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "memb" } });

    const option = await screen.findByRole("option");
    fireEvent.click(within(option).getByRole("button"));

    await waitFor(() =>
      expect(comparePoliticians).toHaveBeenCalledWith("a-member", "b-member"),
    );
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        "/politicians/compare?a=a-member&b=b-member",
        { scroll: false },
      ),
    );
  });

  it("swaps the two sides", async () => {
    searchParams = new URLSearchParams("a=a-member&b=b-member");
    comparePoliticians.mockResolvedValue(compareResponse());
    render(<ComparePanel />);
    await screen.findByText("Companies in both sets of declarations");

    fireEvent.click(screen.getByRole("button", { name: /swap the two members/i }));
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        "/politicians/compare?a=b-member&b=a-member",
        { scroll: false },
      ),
    );
  });

  it("exposes the pickers as comboboxes with a labelled listbox", async () => {
    render(<ComparePanel />);
    const input = screen.getByLabelText("First member");
    expect(input).toHaveAttribute("role", "combobox");
    expect(input).toHaveAttribute("aria-expanded", "false");
    fireEvent.focus(input);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("listbox", { name: /first member results/i }),
    ).toBeInTheDocument();
  });
});

/* ----------------------------------------------------------------- rendered */

describe("compare panel — the comparison", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams("a=a-member&b=b-member");
  });

  it("renders both sides symmetrically, with counts labelled as entries", async () => {
    comparePoliticians.mockResolvedValue(compareResponse());
    render(<ComparePanel />);

    // By role, because the member's name legitimately appears more than once —
    // the card heading and the shared-companies column header.
    await screen.findByRole("link", { name: "A Member" });
    expect(screen.getByRole("link", { name: "B Member" })).toBeInTheDocument();
    // Both cards carry the same tiles in the same order — no side has a tile
    // the other lacks.
    expect(screen.getAllByText("declared entries now")).toHaveLength(2);
    expect(screen.getAllByText("ASX-listed companies")).toHaveLength(2);
    // Item-3 rows are ENTRIES, never "properties owned".
    expect(screen.getAllByText("real-estate entries")).toHaveLength(2);
    expect(screen.queryByText(/owns \d+ propert/i)).toBeNull();
  });

  it("links each side back to its own profile", async () => {
    comparePoliticians.mockResolvedValue(compareResponse());
    const { container } = render(<ComparePanel />);
    // By role, because the member's name legitimately appears more than once —
    // the card heading and the shared-companies column header.
    await screen.findByRole("link", { name: "A Member" });
    expect(
      container.querySelector('a[href="/politicians/a-member"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('a[href="/politicians/b-member"]'),
    ).not.toBeNull();
  });

  it("renders the shared companies as fact, linked to the stock page", async () => {
    comparePoliticians.mockResolvedValue(compareResponse());
    const { container } = render(<ComparePanel />);
    await screen.findByText("Companies in both sets of declarations");
    expect(container.querySelector('a[href="/shorts/BHP"]')).not.toBeNull();
    expect(screen.getByText("BHP Group")).toBeInTheDocument();
    expect(screen.getByText("Materials")).toBeInTheDocument();
    // Each side's holder and currently-declared state, both stated.
    expect(screen.getAllByText("Currently declared").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Previously declared").length).toBeGreaterThan(0);
  });

  it("caps the one-sided lists and counts BOTH the local and API tails", async () => {
    comparePoliticians.mockResolvedValue(compareResponse());
    render(<ComparePanel />);
    await screen.findByText("Companies in only one");
    // 10 returned, 8 shown, plus the 3 the API had already trimmed.
    expect(screen.getByText("+5 more")).toBeInTheDocument();
  });

  it("states each member's coverage and that the counts are not like-for-like", async () => {
    comparePoliticians.mockResolvedValue(compareResponse());
    render(<ComparePanel />);
    await screen.findByText("What has been read, for each member");
    expect(
      screen.getByText(/may be a difference in our coverage rather than in what was declared/i),
    ).toBeInTheDocument();
    // Per-side, not one merged note.
    expect(screen.getByText(/47th and 48th/)).toBeInTheDocument();
    expect(screen.getByText(/44th, 45th, 46th and 47th/)).toBeInTheDocument();
    // Undated entries are stated rather than silently folded into a count.
    expect(screen.getByText(/5 entries carry no stated date/i)).toBeInTheDocument();
  });

  it("shows the source, the licence and the as-at date from the response", async () => {
    comparePoliticians.mockResolvedValue(compareResponse());
    render(<ComparePanel />);
    await screen.findByText(/Licence: CC BY-NC-ND 4.0/);
    expect(screen.getByText(/Register of Members/)).toBeInTheDocument();
    expect(screen.getByText(/as at/i)).toBeInTheDocument();
    expect(screen.getByText(/Report an error/i)).toBeInTheDocument();
  });

  it("gives every graphic a text fallback", async () => {
    comparePoliticians.mockResolvedValue(compareResponse());
    const { container } = render(<ComparePanel />);
    await screen.findByText("Entries by register category");
    const graphics = Array.from(container.querySelectorAll('[role="img"]'));
    expect(graphics.length).toBeGreaterThan(0);
    for (const graphic of graphics) {
      expect(graphic.getAttribute("aria-label")).toBeTruthy();
    }
    // …and a real table behind each chart, not just a label.
    expect(container.querySelectorAll("table.sr-only").length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ colours */

describe("compare panel — series colours", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams("a=a-member&b=b-member");
  });

  it("tints each side by its own party colour", async () => {
    comparePoliticians.mockResolvedValue(compareResponse());
    const { container } = render(<ComparePanel />);
    await screen.findByText("Entries by register category");
    const colors = new Set(barColors(container));
    expect(colors).toContain(rgb(partyColorFromAb("ALP")));
    expect(colors).toContain(rgb(partyColorFromAb("LP")));
  });

  it("falls back to a muted slate — never red/green — when both share a party", async () => {
    const response = compareResponse();
    (response.b.politician as { partyAb: string }).partyAb = "ALP";
    comparePoliticians.mockResolvedValue(response);
    const { container } = render(<ComparePanel />);
    await screen.findByText("Entries by register category");

    const colors = new Set(barColors(container));
    expect(colors.size).toBe(2);
    expect(colors).toContain(rgb(partyColorFromAb("ALP")));
    expect(colors).toContain("rgb(100, 116, 139)");
    // The pairing must not be a good/bad one about two named people.
    expect(colors).not.toContain("rgb(0, 128, 0)");
    expect(colors).not.toContain("rgb(255, 0, 0)");
  });

  it("says which side the slate belongs to rather than leaving it to be inferred", async () => {
    const response = compareResponse();
    (response.b.politician as { partyAb: string }).partyAb = "ALP";
    comparePoliticians.mockResolvedValue(response);
    render(<ComparePanel />);
    await screen.findByText("Entries by register category");
    // In the header card…
    expect(screen.getAllByText(/shown in slate/i).length).toBeGreaterThan(0);
    // …and in the chart legend name, which is also what the aria-label reads.
    expect(
      screen.getAllByLabelText(/B Member \(Labor, shown in slate\)/i).length,
    ).toBeGreaterThan(0);
  });
});

/* ---------------------------------------------------------------- editorial */

/**
 * The words this feature exists to not be. The wireframe this page was adapted
 * from carried a "Battle Score 62–38" and a trophy; none of that vocabulary may
 * survive anywhere a reader — or a screen reader — can reach it.
 */
const RANKING_WORDS =
  // `leading(?!-)` and not a bare `leading`: Tailwind's line-height utility is
  // `leading-relaxed`, and a rule that flags a CSS class is a rule the next
  // person deletes.
  /\b(battle|winner|wins|beats|ahead of|advantage|scores?|trophy|leads|leading(?!-))\b/i;
const BANNED_GLYPHS = /[⚠🚨🔴🚩👀💰💵🪙💲🏆🥇]/u;

const ROUTE_DIR = join(__dirname, "..", "..", "..", "..", "app", "politicians", "compare");
const ROUTE_FILES = [
  "page.tsx",
  "compare-panel.tsx",
  "compare-panel-loader.tsx",
  "opengraph-image.tsx",
];

function proseOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("compare panel — editorial", () => {
  it.each(ROUTE_FILES)("%s carries no ranking vocabulary", (name) => {
    const prose = proseOnly(readFileSync(join(ROUTE_DIR, name), "utf8"));
    expect(prose.match(RANKING_WORDS)?.[0] ?? null).toBeNull();
  });

  it.each(ROUTE_FILES)("%s carries no currency or warning iconography", (name) => {
    const source = readFileSync(join(ROUTE_DIR, name), "utf8");
    expect(source.match(BANNED_GLYPHS)?.[0] ?? null).toBeNull();
    expect(proseOnly(source).match(/\$\{?\s*\d/)?.[0] ?? null).toBeNull();
  });

  it("renders no ranking vocabulary, currency or warning glyph", async () => {
    searchParams = new URLSearchParams("a=a-member&b=b-member");
    comparePoliticians.mockResolvedValue(compareResponse());
    const { container } = render(<ComparePanel />);
    await screen.findByText("Entries by register category");

    // Everything a reader can reach, including the sr-only tables and every
    // aria-label on a graphic.
    const labels = Array.from(container.querySelectorAll("[aria-label]"))
      .map((el) => el.getAttribute("aria-label") ?? "")
      .join(" ");
    const text = `${container.textContent ?? ""} ${labels}`;

    expect(text.match(RANKING_WORDS)?.[0] ?? null).toBeNull();
    expect(text).not.toMatch(BANNED_GLYPHS);
    expect(text).not.toMatch(/\$\s*\d/);
  });
});
