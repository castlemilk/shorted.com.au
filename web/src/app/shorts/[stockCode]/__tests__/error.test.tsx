/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

let pathname: string | null = "/shorts/BHP";
jest.mock("next/navigation", () => ({ usePathname: () => pathname }));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

import StockError from "../error";

function renderError() {
  return render(
    <StockError
      error={Object.assign(new Error("boom"), { digest: "abc" })}
      reset={jest.fn()}
    />,
  );
}

describe("the stock segment's error card", () => {
  beforeEach(() => {
    // The boundary logs the error it caught; that is not what is under test.
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    pathname = "/shorts/BHP";
  });

  it("names the stock on the Overview", () => {
    pathname = "/shorts/BHP";
    renderError();
    expect(screen.getByText("We couldn't load the data for BHP")).toBeInTheDocument();
  });

  // The last segment of a tab route is the tab: the card once read "We couldn't
  // load the data for STRATEGY".
  it.each([
    "/shorts/BHP/short-interest",
    "/shorts/BHP/strategy",
    "/shorts/BHP/financials",
    "/shorts/BHP/company",
    "/shorts/BHP/news",
    "/shorts/BHP/community",
    "/shorts/BHP/community/thread-1",
  ])("names the stock, not the tab or the thread, on %s", (path) => {
    pathname = path;
    renderError();
    expect(screen.getByText("We couldn't load the data for BHP")).toBeInTheDocument();
  });

  it("shouts the code whatever the case of the URL", () => {
    pathname = "/shorts/bhp/strategy";
    renderError();
    expect(screen.getByText("We couldn't load the data for BHP")).toBeInTheDocument();
  });

  it("says 'this stock' when the path is not a stock's", () => {
    pathname = "/somewhere/else";
    renderError();
    expect(screen.getByText("We couldn't load the data for this stock")).toBeInTheDocument();
  });

  it("says 'this stock' when there is no path to read", () => {
    pathname = null;
    renderError();
    expect(screen.getByText("We couldn't load the data for this stock")).toBeInTheDocument();
  });

  it("still logs the error it caught", () => {
    renderError();
    expect(console.error).toHaveBeenCalledWith("Stock page error:", expect.objectContaining({ message: "boom" }));
  });
});
