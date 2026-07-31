import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { render, screen } from "@testing-library/react";

import { TrendArea } from "../trend-area";

const COMPONENT_DIR = join(__dirname, "..");
const COMPONENT_FILES = readdirSync(COMPONENT_DIR)
  .filter((entry) => /\.tsx?$/.test(entry))
  .map((entry) => join(COMPONENT_DIR, entry));

const BANNED_GLYPHS = [
  "💰",
  "💵",
  "💴",
  "💶",
  "💷",
  "🪙",
  "💲",
  "⚠",
  "🚨",
  "🔴",
  "🚩",
  "👀",
  "🏆",
];

const BANNED_VERBS = /\b(?:bought|corrupt\w*|rigged|bribed|rorted|kickback)\b/i;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("explorer editorial safeguards", () => {
  it.each(COMPONENT_FILES)("%s contains no banned glyphs", (file) => {
    const source = readFileSync(file, "utf8");
    for (const glyph of BANNED_GLYPHS) {
      expect(source).not.toContain(glyph);
    }
  });

  it.each(COMPONENT_FILES)(
    "%s contains no banned editorial verb in a string",
    (file) => {
      expect(stripComments(readFileSync(file, "utf8"))).not.toMatch(
        BANNED_VERBS,
      );
    },
  );

  it("locks singular and plural undated footnote wording", () => {
    const { rerender } = render(<TrendArea points={[]} undatedCount={1} />);
    expect(
      screen.getByText("1 entry without a stated date are not plotted."),
    ).toBeInTheDocument();

    rerender(<TrendArea points={[]} undatedCount={3} />);
    expect(
      screen.getByText("3 entries without a stated date are not plotted."),
    ).toBeInTheDocument();
  });

  it("renders no currency prefix in the default component states", () => {
    const { container } = render(<TrendArea points={[]} />);
    expect(container.textContent).not.toMatch(/\$\s*\d/);
  });
});
