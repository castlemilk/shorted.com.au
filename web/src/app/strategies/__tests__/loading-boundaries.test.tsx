/// <reference types="jest" />
import "@testing-library/jest-dom";
import * as fs from "fs";
import * as path from "path";
import { render, screen } from "@testing-library/react";

/**
 * Every page under the profile segment has a loading.tsx, and it is a labelled
 * status region that is busy, so a cold visit announces that the tab is loading.
 * The boundaries are found on disk, so one added later is held to the same rule.
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
  it("has one for the Overview", () => {
    expect(files).toEqual([path.join(SEGMENT_DIR, "loading.tsx")]);
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
