import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { AustralianInvestorDirectory } from "../australian-investor-directory";
import { NamedFilerRegister } from "../named-filer-register";
import type {
  Discovery,
  DisclosureRow,
} from "~/@/lib/ownership/investor-disclosures";

import { loadInvestorRegisters } from "~/app/actions/investorWatchlist";
import {
  filingId,
  type InvestorRegister,
} from "~/@/lib/ownership/investor-activity";
import { filerId } from "~/@/lib/ownership/named-filer";
import { parseTrackerQuery } from "../tracker-query";
jest.mock("~/app/actions/investorWatchlist", () => ({
  loadInvestorRegisters: jest.fn(),
}));
const readRegisters = jest.mocked(loadInvestorRegisters);
const followKey = "shorted:ownership:followed-asx-investors:v1";
const readKey = "shorted:ownership:read-asx-notices:v1";
const route = "/ownership/traders/australia";
const rawName = "MR JOSHUA GORDON";
let selected = "";
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams({ name: selected }),
}));
const row: DisclosureRow = {
  code: "RLC",
  company: "Reedy Lagoon",
  name: rawName,
  date: "2026-11-05",
  effective: "2026-11-04",
  form: "603",
  event: "became",
  ceased: false,
  pct: 8.16,
  previous: null,
  profile: null,
  source: "https://www.asx.com.au/gordon",
};
const feed: Discovery = {
  status: "complete",
  asOf: "2026-11-06",
  read: 2,
  total: 2,
  rows: [{ ...row, name: "Nominees Pty Ltd", pct: 30 }, row],
};
beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", route);
  readRegisters.mockReset().mockImplementation(async (codes) =>
    codes.map((code) => ({
      code,
      asOf: feed.asOf,
      limited: false,
      notices: [],
    })),
  );
  selected = "";
});

it("follows and removes a reviewed investor across mounts", async () => {
  const view = render(<AustralianInvestorDirectory feed={feed} />);
  fireEvent.click(screen.getByRole("button", { name: "Follow Gerry Harvey" }));
  view.unmount();
  render(<AustralianInvestorDirectory feed={feed} />);
  fireEvent.click(screen.getByRole("button", { name: "Following (1)" }));
  await screen.findByText(/1 of 1 issuer register loaded/);
  expect(screen.getByRole("link", { name: "Gerry Harvey" })).toBeVisible();
  expect(screen.queryByRole("link", { name: "Richard White" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Follow Gerry Harvey" }));
  expect(screen.getByText(/No followed profiles/)).toBeVisible();
});

it("follows a new as-filed name and keeps the issuer link after its notice leaves discovery", async () => {
  selected = rawName;
  const props = {
    code: "RLC",
    current: [{ name: rawName, pct: 8.16, date: "2026-11-05" }],
    history: [row],
    limited: false,
  };
  const view = render(<NamedFilerRegister {...props} />);
  fireEvent.click(screen.getByRole("button", { name: `Follow ${rawName}` }));
  expect(
    screen.getByRole("link", { name: "View followed filings" }),
  ).toHaveAttribute("href", route + "?view=following");
  view.unmount();
  render(<AustralianInvestorDirectory feed={{ ...feed, rows: [] }} />);
  fireEvent.click(screen.getByRole("button", { name: "Following (1)" }));
  await screen.findByText(/1 of 1 issuer register loaded/);
  expect(screen.getByRole("link", { name: rawName })).toHaveAttribute(
    "href",
    "/ownership/traders/asx/RLC/holders?name=MR+JOSHUA+GORDON",
  );
});

it("searches market names and dated register ranks, with original sources and scoped links", () => {
  render(<AustralianInvestorDirectory feed={feed} />);
  fireEvent.click(screen.getByRole("button", { name: "Recent filings" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /personal title/ }));
  expect(screen.queryByText("Nominees Pty Ltd")).toBeNull();
  expect(screen.getByRole("link", { name: rawName })).toHaveAttribute(
    "href",
    "/ownership/traders/asx/RLC/holders?name=MR+JOSHUA+GORDON",
  );
  expect(screen.getByRole("link", { name: "Form 603" })).toHaveAttribute(
    "href",
    row.source,
  );
  fireEvent.click(screen.getByRole("button", { name: "Annual ranks" }));
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "RealWise" },
  });
  const table = within(screen.getByRole("table"));
  expect(
    table.getAllByRole("link", { name: "RealWise Holdings Pty Limited" }),
  ).toHaveLength(2);
  expect(table.getByText("92,675,710")).toBeVisible();
  expect(table.getByText("2,602,606")).toBeVisible();
});

it("keeps filings outages distinct from a successful search with no matches", () => {
  render(
    <AustralianInvestorDirectory
      feed={{ ...feed, status: "unavailable", rows: [] }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Recent filings" }));
  expect(screen.getByRole("status")).toHaveTextContent(
    "temporarily unavailable",
  );
  expect(screen.queryByText("No filings match this search.")).toBeNull();
});

it("retains shareable filters, restores a view on back and preserves unrelated URL parameters", () => {
  const url =
    route +
    "?campaign=asx&view=filings&q=Gordon&event=became&titled=1#activity";
  window.history.replaceState(null, "", url);
  const first = render(<AustralianInvestorDirectory feed={feed} />);
  expect(
    screen.getByRole("button", { name: "Recent filings" }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("searchbox")).toHaveValue("Gordon");
  expect(
    screen.getByRole("checkbox", { name: /personal title/ }),
  ).toBeChecked();
  expect(screen.getByRole("combobox", { name: "Disclosure" })).toHaveValue(
    "became",
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Order by" }), {
    target: { value: "power" },
  });
  const filteredUrl = window.location.href;
  first.unmount();
  render(<AustralianInvestorDirectory feed={feed} />);
  expect(screen.getByRole("combobox", { name: "Order by" })).toHaveValue(
    "power",
  );
  expect(screen.getByRole("link", { name: rawName })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Annual ranks" }));
  expect(window.location.search).toBe("?campaign=asx&view=ranks");
  expect(window.location.hash).toBe("#activity");
  act(() => {
    window.history.replaceState(null, "", filteredUrl);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(screen.getByRole("searchbox")).toHaveValue("Gordon");
  expect(screen.getByRole("combobox", { name: "Order by" })).toHaveValue(
    "power",
  );
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(window.location.search).toBe("?campaign=asx&view=filings");
  expect(readRegisters).not.toHaveBeenCalled();
});

it("ignores unknown or inapplicable URL filters and nonpositive, fractional or unsafe page numbers", () => {
  expect(
    parseTrackerQuery(
      "?view=other&sort=move&event=decreased&titled=1&unread=1&page=3",
    ),
  ).toEqual(parseTrackerQuery(""));
  for (const page of ["-5", "1.3", "Infinity", "9007199254740992"]) {
    expect(parseTrackerQuery("?view=filings&page=" + page).page).toBe(1);
  }
  expect(
    parseTrackerQuery(
      "?view=following&sort=other&event=x&titled=1&unread=1&page=2",
    ),
  ).toMatchObject({
    order: "latest",
    event: "",
    titled: false,
    unread: true,
    page: 2,
  });
});

it("dates directory figures and keeps annual percentages distinct from a reported voting interest", () => {
  render(
    <AustralianInvestorDirectory
      feed={{
        ...feed,
        rows: [
          { ...row, code: "MGH", profile: "wesley-and-emma-maas", pct: 55.05 },
        ],
      }}
    />,
  );
  const notice = screen
    .getByRole("button", { name: /Follow Wesley/ })
    .closest("li")!;
  expect(within(notice).getByText("55.05% voting power")).toBeVisible();
  expect(
    within(notice).getByRole("link", { name: "Form 603" }),
  ).toHaveAttribute("href", row.source);
  const register = screen
    .getByRole("button", { name: "Follow Richard White" })
    .closest("li")!;
  expect(within(register).getByText(/#1 · .* of issued shares/)).toBeVisible();
  expect(
    within(register).getByText("RealWise Holdings Pty Limited"),
  ).toBeVisible();
  expect(
    within(register).getByRole("link", { name: "Annual register" }),
  ).toHaveAttribute("href", expect.stringContaining("#page="));
});

it("keeps older covered notices in the inbox, marks just the shown page, and syncs read status across mounts and tabs", async () => {
  // Legacy saves contain only the as-filed name and issuer key.
  localStorage.setItem(
    followKey,
    JSON.stringify([
      { id: filerId(row.code, row.name), code: row.code, name: row.name },
    ]),
  );
  const notices = Array.from({ length: 26 }, (_, i) => ({
    ...row,
    date: "2024-01-" + String(i + 1).padStart(2, "0"),
    source: `https://asx.com.au/release-${i}`,
  }));
  readRegisters.mockResolvedValue([
    { code: row.code, asOf: feed.asOf, limited: true, notices },
  ]);
  window.history.replaceState(null, "", route + "?view=following");
  const first = render(
    <AustralianInvestorDirectory feed={{ ...feed, rows: [] }} />,
  );
  const table = within(
    await screen.findByRole("table", { name: /Filings from followed/ }),
  );
  expect(table.getAllByRole("row")).toHaveLength(26);
  expect(screen.getByText(/latest 100 issuer notices for RLC/)).toBeVisible();
  fireEvent.click(screen.getByRole("checkbox", { name: "Unread only" }));
  fireEvent.click(screen.getByRole("button", { name: "Mark shown as read" }));
  expect(table.getAllByRole("row")).toHaveLength(2);
  expect(table.getByText("2024-01-01")).toBeVisible();
  expect(JSON.parse(localStorage.getItem(readKey)!)).toHaveLength(25);
  first.unmount();
  render(<AustralianInvestorDirectory feed={feed} />);
  await screen.findByText("2024-01-01");
  const toggle = screen.getByRole("button", { name: /Read filing from/ });
  fireEvent.click(toggle);
  expect(screen.getByText(/No unread filings match/)).toBeVisible();
  fireEvent.click(screen.getByRole("checkbox", { name: "Unread only" }));
  expect(
    screen.getAllByRole("button", { name: /Read filing from/ })[0],
  ).toHaveAttribute("aria-pressed", "true");
  act(() => {
    localStorage.setItem(readKey, JSON.stringify([filingId(notices[0]!)]));
    window.dispatchEvent(new StorageEvent("storage", { key: readKey }));
  });
  expect(
    screen.getAllByRole("button", { name: /Read filing from/ })[0],
  ).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(screen.getByRole("button", { name: "Show more filings" }));
  expect(screen.getByRole("button", { name: /2024-01-01/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(window.location.search).toContain("page=2");
});

it("shows successful issuers during an outage and retries just the missing register", async () => {
  localStorage.setItem(
    followKey,
    JSON.stringify([{ id: "gina-rinehart", name: "Gina Rinehart" }]),
  );
  window.history.replaceState(null, "", route + "?view=following");
  const reg = (code: string, ok: boolean): InvestorRegister => ({
    code,
    asOf: ok ? feed.asOf : null,
    limited: false,
    notices: ok
      ? [
          {
            ...row,
            code,
            name: "Mrs Georgina Hope Rinehart, Hancock Prospecting Pty Ltd",
            profile: "gina-rinehart",
          },
        ]
      : [],
  });
  readRegisters
    .mockResolvedValueOnce([reg("BM1", false), reg("WCN", true)])
    .mockResolvedValueOnce([reg("BM1", true)]);
  render(<AustralianInvestorDirectory feed={feed} />);
  await screen.findByText(/Registers unavailable for BM1/);
  expect(screen.getByText(/1 of 2 issuer registers loaded/)).toBeVisible();
  const table = within(screen.getByRole("table", { name: /Filings from/ }));
  expect(table.getByRole("link", { name: "WCN" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Retry unavailable/ }));
  await waitFor(() =>
    expect(table.getByRole("link", { name: "BM1" })).toBeVisible(),
  );
  expect(readRegisters.mock.calls).toEqual([[["BM1", "WCN"]], [["BM1"]]]);
  expect(screen.queryByText(/Registers unavailable/)).toBeNull();
});

it("offers discovery from an empty following view without fetching registers", async () => {
  window.history.replaceState(null, "", route + "?view=following");
  render(<AustralianInvestorDirectory feed={feed} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Browse recent filings" }),
  );
  expect(screen.getByRole("table", { name: /Latest releases/ })).toBeVisible();
  expect(readRegisters).not.toHaveBeenCalled();
});

it("orders individual registered accounts by the percentage of issued shares and restores the sort from a link", () => {
  window.history.replaceState(null, "", route + "?view=ranks");
  render(<AustralianInvestorDirectory feed={feed} />);
  const table = within(
    screen.getByRole("table", { name: /Registered accounts/ }),
  );
  expect(table.getAllByRole("row")[4]).toHaveTextContent(
    "Ms. Samantha Maree Harvey",
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Order by" }), {
    target: { value: "stake" },
  });
  expect(table.getAllByRole("row")[1]).toHaveTextContent("Mr. Gerald Harvey");
  expect(table.getAllByRole("row")[2]).toHaveTextContent(
    "RealWise Holdings Pty Limited",
  );
  expect(table.getAllByRole("row")[4]).toHaveTextContent(
    "MRS EMMA MARGARET MAAS",
  );
  expect(window.location.search).toContain("sort=stake");
  expect(parseTrackerQuery(window.location.search).largestStake).toBe(true);
});

it("recovers from a storage failure and can undo an individual read", async () => {
  localStorage.setItem(
    followKey,
    JSON.stringify([
      { id: filerId(row.code, row.name), name: row.name, code: row.code },
    ]),
  );
  window.history.replaceState(null, "", route + "?view=following");
  readRegisters.mockResolvedValue([
    { code: row.code, asOf: feed.asOf, limited: false, notices: [row] },
  ]);
  render(<AustralianInvestorDirectory feed={feed} />);
  const toggle = await screen.findByRole("button", {
    name: /Read filing from/,
  });
  jest.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
    throw new Error("quota");
  });
  fireEvent.click(toggle);
  expect(screen.getByText(/Read status could not be saved/)).toBeVisible();
  expect(toggle).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(toggle);
  expect(screen.queryByText(/Read status could not be saved/)).toBeNull();
  expect(toggle).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-pressed", "false");
  jest.restoreAllMocks();
});
