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

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

/**
 * Really focus the field, rather than dispatching a focus event at it.
 *
 * `toHaveFocus()` is the assertion these tests exist for — the whole point of an
 * `aria-activedescendant` combobox is that focus NEVER leaves the input — and
 * only a real `.focus()` moves `document.activeElement`. It is act-wrapped
 * because it lands a state update (the listbox opens) outside React's batch.
 */
function focusInput(input: HTMLElement) {
  act(() => {
    input.focus();
  });
}

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

    // mousedown, not click: an option is not a button any more (a focusable
    // control inside role="option" is an invalid listbox), and mousedown is what
    // fires before the input's own blur.
    fireEvent.mouseDown(await screen.findByRole("option"));

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

  /**
   * A DEEP LINK MUST SHOW ITS SELECTION.
   *
   * Every profile links here as `?a=<slug>`, and with only one side chosen no
   * compare request fires — so nothing ever supplied the canonical name and the
   * picker rendered blank while a member was selected. No name, no Clear button,
   * nothing to tell the reader what the page thought they had asked for.
   */
  it("shows the deep-linked member as a visible, clearable selection", async () => {
    searchParams = new URLSearchParams("a=anthony-albanese");
    render(<ComparePanel />);

    // The VALUE, not the placeholder: a placeholder is grey, is not a
    // selection, and vanishes the moment anything is typed.
    expect(screen.getByLabelText("First member")).toHaveValue("Anthony Albanese");
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
    // The unchosen side is genuinely empty, and offers nothing to clear.
    expect(screen.getByLabelText("Second member")).toHaveValue("");
    expect(screen.getAllByRole("button", { name: "Clear" })).toHaveLength(1);
  });

  it("replaces the humanised slug with the canonical name once the comparison lands", async () => {
    searchParams = new URLSearchParams("a=a-member&b=b-member");
    comparePoliticians.mockResolvedValue(compareResponse());
    render(<ComparePanel />);

    await screen.findByRole("link", { name: "A Member" });
    // "a-member" was the stand-in; the register's own display name wins the
    // moment there is one.
    expect(screen.getByLabelText("First member")).toHaveValue("A Member");
  });

  /**
   * THE WHOLE FLOW, WITHOUT A POINTER.
   *
   * The widget announced role="combobox" and implemented none of the pattern:
   * no key handler at all, so ArrowDown scrolled the page and the only way to
   * pick a member was to see the list and click it.
   */
  it("selects a member from the keyboard alone", async () => {
    searchParams = new URLSearchParams("a=a-member");
    comparePoliticians.mockResolvedValue(compareResponse());
    render(<ComparePanel />);

    const input = screen.getByLabelText("Second member");
    focusInput(input);
    fireEvent.change(input, { target: { value: "memb" } });

    const option = await screen.findByRole("option");
    expect(option).toHaveAttribute("aria-selected", "false");
    expect(input).not.toHaveAttribute("aria-activedescendant");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(option).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", option.id);
    // Focus never leaves the input — that is what makes activedescendant the
    // thing a screen reader announces.
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(comparePoliticians).toHaveBeenCalledWith("a-member", "b-member"),
    );
    expect(input).toHaveFocus();
    expect(screen.queryByRole("listbox", { name: /second member results/i })).toBeNull();
  });

  it("closes the list on Escape and keeps focus in the field", async () => {
    render(<ComparePanel />);
    const input = screen.getByLabelText("First member");
    focusInput(input);
    await screen.findByRole("option");

    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("listbox", { name: /first member results/i })).toBeNull();
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("does nothing on Enter until an option is actually active", async () => {
    searchParams = new URLSearchParams("a=a-member");
    render(<ComparePanel />);
    const input = screen.getByLabelText("Second member");
    focusInput(input);
    await screen.findByRole("option");

    fireEvent.keyDown(input, { key: "Enter" });

    // No accidental pick of whoever happens to be first.
    expect(comparePoliticians).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Second member")).toHaveValue("");
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

  /**
   * KEY FACTS: EVERY SENTENCE NAMES THE BASE IT IS COUNTED ON.
   *
   * Two of these three are all-time (the shared and one-sided company lists span
   * every declaration in the documents we have read, current or since removed —
   * the same basis as the Currently/Previously chips in the tables above) and
   * one is currently-declared (the same basis as the header cards' tiles).
   * Unlabelled they read as arithmetic about two named people and contradict
   * each other: "1 company appears in both" beside "A declares 4; B declares 2"
   * cannot both describe one set, and a reader who resolves that contradiction
   * is inferring something we never said. The numbers here are exactly the ones
   * the panel always rendered; only the base is now stated.
   */
  it("states the base each key fact is counted on", async () => {
    comparePoliticians.mockResolvedValue(compareResponse());
    render(<ComparePanel />);
    await screen.findByText("Key facts");

    expect(
      screen.getByText(
        "Across the parliaments we have read, 1 ASX-listed company appears in both members' declarations.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "A Member currently declares 4 distinct ASX-listed companies; B Member currently declares 2.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Across the parliaments we have read, 13 companies appear only in A Member's declarations, and 1 only in B Member's.",
      ),
    ).toBeInTheDocument();
  });

  it("leaves no key fact stating a count without its base", async () => {
    comparePoliticians.mockResolvedValue(compareResponse());
    render(<ComparePanel />);
    const card = (await screen.findByText("Key facts")).closest("section");
    const sentences = Array.from(card?.querySelectorAll("li") ?? []).map(
      (li) => li.textContent ?? "",
    );
    expect(sentences.length).toBeGreaterThan(0);
    for (const sentence of sentences) {
      // Either it says when it was counted, or it is the undated-entries note,
      // which is about entries carrying no date at all rather than about a
      // population of companies.
      expect(
        /currently declares|across the parliaments we have read|no stated date/i.test(sentence),
      ).toBe(true);
    }
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
    //
    // RE-PINNED 2026-08-02: the selector was `table.sr-only`, which pinned the
    // exact bug it was meant to guard against. `sr-only` sets `width:1px`, and
    // on a `display:table` box that is a MINIMUM, not a cap — so the table laid
    // out at full content width and, being absolutely positioned, added that to
    // the document's scroll width (+354 px of horizontal overflow on this route
    // at 375 px, +1352 px on /donations). The clip now lives on a block wrapper.
    // What this test actually cares about is unchanged: a real <table>, hidden
    // from sighted readers, behind every chart.
    const hiddenTables = container.querySelectorAll(".sr-only table");
    expect(hiddenTables.length).toBeGreaterThan(0);
    // The class must NOT be back on the table itself — that is the regression.
    expect(container.querySelectorAll("table.sr-only").length).toBe(0);
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

/* ---------------------------------------------------- the unread Senate side */

/**
 * A senator whose register we have NOT read, on one side of the comparison.
 *
 * This is not "a member who declares nothing". The Registers of Senators'
 * Interests are tabled as combined volumes and none of them has been read into
 * this site, so this side has no data at all — and every symmetric surface on
 * the page was rendering that absence as a measurement of a named person.
 */
function senateGapSummary() {
  return summary({
    politician: member({
      slug: "s-senator",
      displayName: "S Senator",
      chamber: "senate",
      division: "",
      stateCode: "QLD",
      partyAb: "GRN",
      declaredListedCount: 0,
      declaredPropertyCount: 0,
    }),
    itemCounts: [],
    distinctCompanyCount: 0,
    propertyCount: 0,
    giftsTravelCount: 0,
    liabilityCount: 0,
    changes90d: 0,
    undatedCount: 0,
  });
}

function senateGapResponse() {
  return compareResponse({
    b: senateGapSummary(),
    holderCountsB: [],
    sharedCompanies: [],
    onlyBCompanies: [],
    onlyBMore: 0,
    // The buckets the panel used to print verbatim over an empty senator:
    // "Read in full: the 45th and 48th Parliaments".
    extractedParliamentsB: [45, 48],
    partialParliamentsB: [],
    pendingParliamentsB: [],
  });
}

async function renderSenateGap() {
  searchParams = new URLSearchParams("a=a-member&b=s-senator");
  comparePoliticians.mockResolvedValue(senateGapResponse());
  render(<ComparePanel />);
  await waitFor(() =>
    expect(screen.getByText(/What has been read, for each member/i)).toBeInTheDocument(),
  );
}

const SENATE_GAP_SENTENCE = /tabled as combined Senate volumes/i;

describe("compare panel — a senator whose register is unread", () => {
  it("never claims a parliament has been read in full for that side", async () => {
    await renderSenateGap();
    // The bug: "Read in full: the 45th and 48th Parliaments" above five zero
    // tiles, for a chamber whose volumes we have never opened.
    expect(screen.queryByText(/45th and 48th/)).not.toBeInTheDocument();
    // The member's own coverage is unaffected — his registers WERE read.
    expect(screen.getByText(/47th and 48th/)).toBeInTheDocument();
  });

  it("states whose absence it is, in the shared wording", async () => {
    await renderSenateGap();
    expect(screen.getAllByText(SENATE_GAP_SENTENCE).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/our coverage gap — not a record that this senator declared nothing/i)
        .length,
    ).toBeGreaterThan(0);
  });

  it("does not say the senator currently declares 0", async () => {
    await renderSenateGap();
    expect(screen.queryByText(/currently declares 0/i)).not.toBeInTheDocument();
    // And it names the side that has no count, rather than leaving a gap.
    expect(screen.getByText(/No count of declared companies is stated for S Senator/i))
      .toBeInTheDocument();
  });

  it("draws no comparison chart for the pairing", async () => {
    await renderSenateGap();
    // Every mark, axis and sr-only cell in these three would be our coverage
    // gap drawn as a measurement of a named person.
    expect(screen.queryByText(/The same counts, grouped/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Whose interest each entry records/i)).not.toBeInTheDocument();
    expect(screen.getByText(/No category comparison is drawn for this pair/i))
      .toBeInTheDocument();
  });

  it("announces no zero for that side anywhere a screen reader can reach", async () => {
    await renderSenateGap();
    // "Senator 0" came out of the compare-bar aria-labels and the sr-only
    // tables. With the charts gone there is nothing left to read it out of.
    const labels = Array.from(document.querySelectorAll("[aria-label]")).map(
      (el) => el.getAttribute("aria-label") ?? "",
    );
    for (const label of labels) {
      expect(label).not.toMatch(/S Senator[^.]*\b0\b/);
    }
    expect(document.body.textContent).not.toMatch(/S Senator[^.]*\b0 entries\b/);
  });

  it("keeps the sections that carry real facts", async () => {
    await renderSenateGap();
    // Shared/one-sided companies and each side's coverage are not drawn
    // absence — they are what we do hold — and they stay.
    expect(screen.getByText(/Companies in both sets of declarations/i)).toBeInTheDocument();
    expect(screen.getByText(/Companies in only one/i)).toBeInTheDocument();
    expect(screen.getByText(/What has been read, for each member/i)).toBeInTheDocument();
  });

  it("leaves a genuinely zero HOUSE member alone", async () => {
    // A member whose documents WE READ and which contained nothing is an
    // established fact, not a coverage gap. Their zeros stay drawn.
    searchParams = new URLSearchParams("a=a-member&b=z-member");
    comparePoliticians.mockResolvedValue(
      compareResponse({
        b: summary({
          politician: member({
            slug: "z-member",
            displayName: "Z Member",
            chamber: "house",
            declaredListedCount: 0,
            declaredPropertyCount: 0,
          }),
          itemCounts: [],
          distinctCompanyCount: 0,
          propertyCount: 0,
          giftsTravelCount: 0,
          liabilityCount: 0,
          changes90d: 0,
          undatedCount: 0,
        }),
      }),
    );
    render(<ComparePanel />);
    await waitFor(() =>
      expect(screen.getByText(/What has been read, for each member/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/currently declares 0/i)).toBeInTheDocument();
    expect(screen.queryByText(/No category comparison is drawn/i)).not.toBeInTheDocument();
  });
});
