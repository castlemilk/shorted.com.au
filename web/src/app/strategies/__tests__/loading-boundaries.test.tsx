/// <reference types="jest" />
import "@testing-library/jest-dom";
import * as fs from "fs";
import * as path from "path";
import { render, screen } from "@testing-library/react";
import { enabledStrategyTabs } from "~/@/lib/strategies/strategy-tabs";

/**
 * Every enabled tab of the profile has a loading.tsx, and it is a labelled
 * status region that is busy, so a cold visit announces that the tab is loading.
 * The expected boundaries come from the tab registry, and the files are found on
 * disk, so a tab enabled later without its boundary fails here.
 */
const SEGMENT_DIR = path.resolve(__dirname, "../[strategy]");

function loadingFilesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return loadingFilesUnder(full);
    return entry.name === "loading.tsx" ? [full] : [];
  });
}

const files = loadingFilesUnder(SEGMENT_DIR).sort();

describe("the strategy profile's loading boundaries", () => {
  it("has one for each enabled tab, and for no other", () => {
    const expected = enabledStrategyTabs()
      .map((tab) => path.join(SEGMENT_DIR, tab.segment, "loading.tsx"))
      .sort();
    expect(files).toEqual(expected);
  });

  it.each(
    files.map((file) => [path.relative(SEGMENT_DIR, file), file] as const),
  )("%s is a labelled status region that is busy", (_name, file) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Loading = (require(file) as { default: () => React.ReactElement })
      .default;
    render(<Loading />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveAttribute("aria-label", "Loading");
  });
});
