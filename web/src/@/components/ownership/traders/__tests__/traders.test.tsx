import { fireEvent, render, screen } from "@testing-library/react";
import { DirectorRecords, type DirectorRecord } from "../director-records";
import { TraderDirectory } from "../trader-directory";
import {
  directorHref,
  isNamedDirectorTrade,
  tradersForHolder,
} from "~/@/lib/ownership/traders";

let query = "";
const push = jest.fn();
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(query),
  useRouter: () => ({ push }),
}));

const base: DirectorRecord = {
  id: "1",
  director: "A. O'Neil",
  date: "2026-11-11",
  type: "Acquisition",
  units: "10,000",
  price: "n/a",
  value: "n/a",
  source: "https://announcements.asx.com.au/example",
};

beforeEach(() => {
  query = "";
  push.mockClear();
});

it("finds a person by reporting manager and opens a company lookup using a normalized ticker", () => {
  render(<TraderDirectory />);
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "  altimeter " },
  });
  expect(screen.getByRole("link", { name: /Brad Gerstner/ })).toHaveAttribute(
    "href",
    "/ownership/traders/brad-gerstner",
  );
  expect(screen.queryByRole("link", { name: /Geoff Wilson/ })).toBeNull();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "no such firm" },
  });
  expect(screen.getByRole("status")).toHaveTextContent("No tracked manager");
  fireEvent.change(screen.getByLabelText("ASX code"), {
    target: { value: "wam" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Find directors" }));
  expect(push).toHaveBeenCalledWith("/ownership/traders/asx/WAM");
});

it("matches a director only within the issuer read, preserving punctuation and disclosing missing values", () => {
  query = directorHref("BHP", base.director).split("?")[1]!;
  render(
    <DirectorRecords
      code="BHP"
      rows={[base, { ...base, id: "2", director: "A Oneil" }]}
    />,
  );
  expect(screen.getByRole("heading", { name: "A. O'Neil" })).toBeVisible();
  expect(screen.getAllByRole("row")).toHaveLength(2);
  expect(screen.getByRole("columnheader", { name: "Units" })).toHaveAttribute(
    "scope",
    "col",
  );
  expect(screen.getByRole("link", { name: /Source filing/ })).toHaveAttribute(
    "href",
    base.source,
  );
  expect(screen.getAllByText("n/a")).toHaveLength(2);
});

it("retains an absent director selection and explains the coverage window", () => {
  query = "director=absent";
  render(<DirectorRecords code="BHP" rows={[base]} />);
  expect(screen.getByLabelText("Director")).toHaveValue("absent");
  expect(
    screen.getByText(/No named, quantified changes for this director/),
  ).toBeVisible();
  expect(screen.queryByRole("table")).toBeNull();
});

it("links a director to public accounts only for the recorded issuer and name", () => {
  const rows = [{ ...base, director: "Geoff Wilson" }];
  query = "director=geoff+wilson";
  const { rerender } = render(<DirectorRecords code="WAM" rows={rows} />);
  expect(
    screen.getByRole("link", { name: /Geoff Wilson’s public accounts/ }),
  ).toHaveAttribute("href", "/ownership/traders/geoff-wilson#public-accounts");
  rerender(<DirectorRecords code="BHP" rows={rows} />);
  expect(screen.queryByRole("link", { name: /public accounts/i })).toBeNull();
});

it("keeps company associations explicit and omits the headline reader's placeholders", () => {
  expect(
    tradersForHolder("wilson-asset-management").map((t) => t.name),
  ).toEqual(["Geoff Wilson"]);
  expect(tradersForHolder("wilson")).toEqual([]);
  expect(
    isNamedDirectorTrade({
      directorName: "Unknown Director",
      sharesTraded: 200n,
    }),
  ).toBe(false);
  expect(
    isNamedDirectorTrade({ directorName: "Geoff Wilson", sharesTraded: 0n }),
  ).toBe(false);
  expect(
    isNamedDirectorTrade({
      directorName: " Geoff Wilson ",
      sharesTraded: 12000n,
    }),
  ).toBe(true);
});
