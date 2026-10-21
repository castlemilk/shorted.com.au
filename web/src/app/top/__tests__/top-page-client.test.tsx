import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { TopPageClient } from "../top-page-client";
import type {
  SerializedMoversData,
  TopPageData,
  TopPeriodData,
} from "~/app/actions/top/getTopPageData";
import type { TopRow } from "~/app/actions/top/top-rows";

const getTopRowsForPeriod = jest.fn<Promise<unknown>, [string]>();
jest.mock("~/app/actions/top/getTopPageData", () => ({
  getTopRowsForPeriod: (period: string) => getTopRowsForPeriod(period),
}));
// The sparkline, treemap and embed dialog all load through next/dynamic.
jest.mock("next/dynamic", () => () => () => null);
// Items are buttons that pick their value, so a test can switch the period.
jest.mock("~/@/components/ui/select", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const Choose = React.createContext<(value: string) => void>(() => undefined);
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Select: ({
      onValueChange,
      children,
    }: {
      onValueChange: (value: string) => void;
      children?: ReactNode;
    }) => <Choose.Provider value={onValueChange}>{children}</Choose.Provider>,
    SelectContent: Pass,
    SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => {
      const choose = React.useContext(Choose);
      return (
        <button type="button" onClick={() => choose(value)}>
          {children}
        </button>
      );
    },
    SelectTrigger: Pass,
    SelectValue: () => null,
  };
});

function row(productCode: string, latestShortPosition: number): TopRow {
  return {
    productCode,
    name: `${productCode} Limited`,
    latestShortPosition,
    change: 0.4,
    sparkline: [latestShortPosition - 0.4, latestShortPosition],
  };
}

function movers(productCode: string): SerializedMoversData {
  return {
    biggestGainers: [
      { productCode, name: `${productCode} Limited`, latestShortPosition: 9, change: 1.5 },
    ],
    biggestLosers: [],
    mostVolatile: [],
  };
}

/** What getTopPageDataForPeriod answered before the rename: the cached TopPageData. */
function preRenameReply(): TopPageData {
  return {
    timeSeries: [
      {
        productCode: "CCC",
        name: "CCC Limited",
        latestShortPosition: 15,
        points: [{ timestamp: "2026-10-16T00:00:00.000Z", shortPosition: 15 }],
      },
    ],
    movers: movers("CCC"),
    stockListItems: [],
    lastUpdated: "2026-10-16T00:00:00.000Z",
    period: "1m",
  };
}

function linkedCodes(container: HTMLElement, section: string): string[] {
  return [
    ...container.querySelectorAll<HTMLAnchorElement>(
      `section[aria-labelledby="${section}"] a[href^="/shorts/"]`,
    ),
  ].map((link) => link.getAttribute("href")!.slice("/shorts/".length));
}

function renderTop() {
  const { container } = render(
    <TopPageClient
      initialData={[row("AAA", 12.5), row("BBB", 8.25)]}
      initialMoversData={movers("AAA")}
      initialPeriod="3m"
    />,
  );
  return {
    ranked: () => linkedCodes(container, "rankings-title"),
    moving: () => linkedCodes(container, "movers-title"),
  };
}

describe("TopPageClient period switch", () => {
  beforeEach(() => {
    getTopRowsForPeriod.mockReset();
  });

  it("shows the rows and movers the period action answers with", async () => {
    const reply: TopPeriodData = { rows: [row("CCC", 15)], movers: movers("CCC") };
    getTopRowsForPeriod.mockResolvedValue(reply);
    const { ranked, moving } = renderTop();
    expect(ranked()).toEqual(["AAA", "BBB"]);

    fireEvent.click(screen.getByRole("button", { name: "1 Month" }));

    await waitFor(() => expect(ranked()).toEqual(["CCC"]));
    expect(moving()).toEqual(["CCC"]);
    expect(getTopRowsForPeriod).toHaveBeenCalledWith("1m");
  });

  // Next 14.2 hashes an action's ID from its file path and export name only,
  // so a tab loaded before a deploy (or a rollback) calls the other build's
  // function. The action once kept its name across a reply change, and the
  // other shape left the table's rows undefined: the render threw into
  // app/error.tsx. Renamed, it reaches a build without the action, which
  // resolves undefined.
  it.each<[string, () => Promise<unknown>]>([
    ["the pre-rename TopPageData", () => Promise.resolve(preRenameReply())],
    ["undefined (no such action in that build)", () => Promise.resolve(undefined)],
    ["a rejection", () => Promise.reject(new Error("network down"))],
  ])("keeps the rows on screen when the reply is %s", async (_label, reply) => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      getTopRowsForPeriod.mockImplementation(reply);
      const { ranked, moving } = renderTop();

      fireEvent.click(screen.getByRole("button", { name: "1 Month" }));

      await waitFor(() =>
        expect(consoleError).toHaveBeenCalledWith("Failed to fetch data:", expect.any(Error)),
      );
      await waitFor(() => expect(screen.queryByText("Updating data...")).toBeNull());
      expect(ranked()).toEqual(["AAA", "BBB"]);
      expect(moving()).toEqual(["AAA"]);
    } finally {
      consoleError.mockRestore();
    }
  });
});
