/**
 * The /politicians hub's two long lists: the roll of every parliamentarian and
 * the most-declared companies.
 *
 * The roll is the only server-rendered index of every profile, so it must keep
 * a plain link to each one. And on a server-rendered page every element in it
 * is sent twice, as HTML and again in the RSC payload's copy of the tree:
 * measured 2026-10-21 the roll was 408 KB of HTML and 557 KB of payload for 491
 * members (a next/link, an inline-styled PartyChip and six spans per card), and
 * the most-declared list 103 KB and 154 KB for 200 rows. These tests keep both
 * lists bare.
 */

import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const MEMBERS = 491;
const COMPANIES = 200;
const PARTIES = ["ALP", "ALP", "LP", "LNP", "GRN", "IND", "NP", "ON", "DHJP", ""];
const STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"];

const roll = Array.from({ length: MEMBERS }, (_, i) => ({
  slug: `member-${i}-surname`,
  displayName: `Given${i} Surname${i}`,
  partyAb: PARTIES[i % PARTIES.length]!,
  // Senators have a state and no division.
  division: i % 3 === 0 ? "" : `Division ${i}`,
  stateCode: STATES[i % STATES.length]!,
  declaredListedCount: i % 7,
  declaredPropertyCount: i % 4,
}));
const stocks = Array.from({ length: COMPANIES }, (_, i) => ({
  stockCode: `C${String(i).padStart(3, "0")}`,
  companyName: `Company Number ${i} Limited`,
  politicianCount: 60 - Math.floor(i / 4),
}));

jest.mock("~/app/actions/getPoliticians", () => ({
  getParliamentOverview: async () => ({ politicianCount: MEMBERS, resolvedListedCount: 296 }),
  getRegisterExplorer: async () => undefined,
  listPoliticianStocks: async () => ({ stocks }),
  listPoliticians: async (chamber: string) =>
    chamber === "senate"
      ? { politicians: [], total: 171 }
      : { politicians: roll, total: MEMBERS },
  getPoliticianAnalytics: async () => undefined,
  listRegisterChanges: async () => undefined,
}));
jest.mock("~/app/actions/politicianTable", () => ({
  loadPoliticianTable: async () => undefined,
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: async () => undefined,
}));
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
// The client islands, which these tests are not about.
jest.mock("@/components/politicians/politician-register-table", () => ({
  PoliticianRegisterTable: () => null,
}));
jest.mock("@/components/politicians/register-heatmap", () => ({
  RegisterHeatmap: () => null,
}));

import PoliticiansPage from "../page";

function find(
  node: ReactNode,
  match: (element: ReactElement) => boolean,
): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, match);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (match(node)) return node;
  return find((node.props as { children?: ReactNode }).children, match);
}

function descendants(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(descendants);
  if (!isValidElement(node)) return [];
  return [node, ...descendants((node.props as { children?: ReactNode }).children)];
}

/**
 * A host-element tree the way React's RSC payload writes it, ["$", type, key,
 * props]: the copy of the list the browser downloads and parses beside the HTML.
 */
function payload(node: ReactNode): unknown {
  if (Array.isArray(node)) return node.map(payload);
  if (!isValidElement(node)) return node ?? null;
  const props: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(node.props as Record<string, unknown>)) {
    if (value === undefined) continue;
    props[name] = name === "children" ? payload(value as ReactNode) : value;
  }
  return ["$", node.type, node.key ?? null, props];
}

const className = (element: ReactElement) =>
  String((element.props as { className?: string }).className ?? "");

async function renderHub() {
  const page = await PoliticiansPage();
  const details = find(page, (element) => element.type === "details")!;
  const rollList = find(details, (element) => element.type === "ul")!;
  const mostDeclared = find(
    page,
    (element) => element.type === "div" && className(element).includes("max-h-[33rem]"),
  )!;
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(page);
  // The page's other <details> are fine print; the roll's is the directory.
  const rollDetails = [...host.querySelectorAll("details")].find((element) =>
    element.querySelector("summary")?.textContent?.includes("members and senators"),
  )!;
  return { page, rollList, mostDeclared, host, rollDetails };
}

describe("/politicians hub: the roll", () => {
  it("links every member's profile as a plain anchor in the server HTML", async () => {
    const { rollDetails } = await renderHub();
    const hrefs = [...rollDetails.querySelectorAll("li > a")].map((a) => a.getAttribute("href"));

    expect(hrefs).toEqual(roll.map((member) => `/politicians/${member.slug}`));
    expect(rollDetails.querySelector("summary")).toHaveTextContent(
      `${MEMBERS} members and senators`,
    );
  });

  it("is bare elements all the way down: no component, no inline style", async () => {
    const { rollList } = await renderHub();
    const elements = descendants(rollList);

    expect(elements.length).toBeGreaterThan(MEMBERS * 3);
    // A component here is a next/link (a client reference to hydrate per
    // member) or PartyChip (an inline-styled tile per member).
    expect(elements.filter((element) => typeof element.type !== "string")).toEqual([]);
    expect(
      elements.filter((element) => (element.props as { style?: unknown }).style !== undefined),
    ).toEqual([]);
  });

  it("stays within a per-member budget in the HTML and in the payload", async () => {
    const { rollList } = await renderHub();
    const html = Buffer.byteLength(renderToStaticMarkup(rollList));
    const rsc = Buffer.byteLength(JSON.stringify(payload(rollList)));

    // ~834 B of HTML and ~1,160 B of payload per member before; ~190 and ~330
    // with the served data after.
    expect(html / MEMBERS).toBeLessThan(300);
    expect(rsc / MEMBERS).toBeLessThan(450);
  });

  it("says each member's party, seat, state and counts in one line each", async () => {
    const { rollDetails } = await renderHub();
    const cards = [...rollDetails.querySelectorAll("li")];

    // ALP, a House member: tile, party, division and state, then counts.
    expect(cards[1]!.querySelector("p")).toHaveTextContent("ALPLabor · Division 1 · VIC");
    expect(cards[1]!.querySelectorAll("p")[1]).toHaveTextContent("1 listed · 1 property");
    // A senator: no division.
    expect(cards[3]!.querySelector("p")).toHaveTextContent("LNPLiberal National · WA");
    // No party held: no tile and no party name, never a guess.
    const unrecorded = cards[19]!.querySelector("p")!;
    expect(unrecorded.querySelector("span")).toBeNull();
    expect(unrecorded).toHaveTextContent(/^Division 19 · WA$/);
  });

  it("draws every tile from the one party stylesheet on the page", async () => {
    const { host, rollDetails } = await renderHub();
    const sheets = host.querySelectorAll("style");
    expect(sheets).toHaveLength(1);
    const css = sheets[0]!.textContent ?? "";

    const tiles = [...rollDetails.querySelectorAll("li span")];
    expect(tiles).toHaveLength(roll.filter((member) => member.partyAb).length);
    for (const tile of tiles) {
      expect(tile).toHaveAttribute("aria-hidden", "true");
      for (const name of tile.className.split(" ")) {
        expect(css).toContain(`.${name}{`);
      }
    }
    // A four-letter monogram takes the smaller type, as PartyMark's does.
    const hinch = tiles.find((tile) => tile.textContent === "DHJP")!;
    expect(hinch.className).toContain("party-tile-long");
  });
});

describe("/politicians hub: the most-declared companies", () => {
  it("lists every company the rpc returns as a plain link with its member count", async () => {
    const { host } = await renderHub();
    const scroller = host.querySelector("div.max-h-\\[33rem\\]")!;
    const rows = [...scroller.querySelectorAll("tbody tr")];

    expect(rows).toHaveLength(COMPANIES);
    expect(rows.map((row) => row.querySelector("a")!.getAttribute("href"))).toEqual(
      stocks.map((stock) => `/shorts/${stock.stockCode}`),
    );
    expect(rows[0]!.querySelector("th")).toHaveTextContent("C000Company Number 0 Limited");
    expect(rows[0]!.querySelector("td")).toHaveTextContent(/^60$/);
    // The bar is scaled to the head of the list, rounded to a tenth of a percent.
    expect((rows[0]!.querySelector("td span") as HTMLElement).style.width).toBe("100%");
    expect((rows[4]!.querySelector("td span") as HTMLElement).style.width).toBe("98.3%");
    // The count line states the window against the corpus total.
    expect(host.textContent).toContain(
      "Showing the 200 most-declared of 296 companies declared in the registers.",
    );
  });

  it("is bare elements within a per-row budget", async () => {
    const { mostDeclared } = await renderHub();
    const elements = descendants(mostDeclared);
    expect(elements.filter((element) => typeof element.type !== "string")).toEqual([]);

    const html = Buffer.byteLength(renderToStaticMarkup(mostDeclared));
    const rsc = Buffer.byteLength(JSON.stringify(payload(mostDeclared)));
    // ~515 B of HTML and ~770 B of payload per row before; ~145 and ~295 after.
    expect(html / COMPANIES).toBeLessThan(200);
    expect(rsc / COMPANIES).toBeLessThan(380);
  });
});
