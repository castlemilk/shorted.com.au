import { fireEvent, render, screen, within } from "@testing-library/react";
import { AustralianInvestorDirectory } from "../australian-investor-directory";
import { NamedFilerRegister } from "../named-filer-register";
import type {
  Discovery,
  DisclosureRow,
} from "~/@/lib/ownership/investor-disclosures";

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
  selected = "";
});

it("follows and removes a reviewed investor across mounts", () => {
  const view = render(<AustralianInvestorDirectory feed={feed} />);
  fireEvent.click(screen.getByRole("button", { name: "Follow Gerry Harvey" }));
  view.unmount();
  render(<AustralianInvestorDirectory feed={feed} />);
  fireEvent.click(screen.getByRole("button", { name: "Following (1)" }));
  expect(screen.getByRole("link", { name: "Gerry Harvey" })).toBeVisible();
  expect(screen.queryByRole("link", { name: "Richard White" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Follow Gerry Harvey" }));
  expect(screen.getByText(/No followed profiles/)).toBeVisible();
});

it("follows a new as-filed name and keeps the issuer link after its notice leaves discovery", () => {
  selected = rawName;
  const props = {
    code: "RLC",
    current: [{ name: rawName, pct: 8.16, date: "2026-11-05" }],
    history: [row],
    limited: false,
  };
  const view = render(<NamedFilerRegister {...props} />);
  fireEvent.click(screen.getByRole("button", { name: `Follow ${rawName}` }));
  view.unmount();
  render(<AustralianInvestorDirectory feed={{ ...feed, rows: [] }} />);
  fireEvent.click(screen.getByRole("button", { name: "Following (1)" }));
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
