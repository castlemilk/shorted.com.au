/// <reference types="jest" />
import "@testing-library/jest-dom";
import * as fs from "fs";
import * as path from "path";
import { render, screen } from "@testing-library/react";
import { STOCK_TABS } from "~/@/lib/stocks/stock-tabs";

/**
 * Every tab segment of /shorts/[stockCode] has a loading.tsx, so a cold tap
 * shows that tab's skeleton inside the chrome while the segment loads (spec
 * section 2, Navigation). A skeleton is a live region: `aria-busy` and
 * `aria-label` on a bare div are not announced, so each one carries
 * `role="status"` as well.
 *
 * The boundaries are found on disk, so one added later is held to the same
 * rule without anyone editing this file.
 */

const STOCK_DIR = path.resolve(__dirname, "../[stockCode]");

function loadingFilesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return loadingFilesUnder(full);
    return entry.name === "loading.tsx" ? [full] : [];
  });
}

const files = loadingFilesUnder(STOCK_DIR).sort();

describe("the stock segment's loading boundaries", () => {
  it("has one for the Overview and one for every other tab", () => {
    const expected = STOCK_TABS.map((tab) =>
      path.join(STOCK_DIR, tab.segment, "loading.tsx"),
    );
    expect(expected).toHaveLength(7);
    expect(files).toEqual(expect.arrayContaining(expected));
  });

  it.each(files.map((file) => [path.relative(STOCK_DIR, file), file] as const))(
    "%s is a labelled status region that is busy",
    (_name, file) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Loading = (require(file) as { default: () => React.ReactElement })
        .default;
      render(<Loading />);
      const status = screen.getByRole("status");
      expect(status).toHaveAttribute("aria-busy", "true");
      expect(status).toHaveAttribute("aria-label", "Loading");
    },
  );
});
