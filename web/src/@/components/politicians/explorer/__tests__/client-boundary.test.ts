import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const COMPONENT_DIR = join(__dirname, "..");
const COMPONENT_FILES = readdirSync(COMPONENT_DIR)
  .filter((entry) => /\.tsx?$/.test(entry))
  .map((entry) => join(COMPONENT_DIR, entry));

const FORBIDDEN_IMPORTS =
  /(?:politicians_pb|@bufbuild\/protobuf|@connectrpc\/connect|recharts|visx|d3)/i;

describe("explorer component boundary", () => {
  it("keeps every kit component server-safe", () => {
    for (const file of COMPONENT_FILES) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/^\s*["']use client["']/m);
      expect(source).not.toMatch(FORBIDDEN_IMPORTS);
    }
  });

  it("uses the frozen compliance copy only from a server component", () => {
    const about = readFileSync(
      join(COMPONENT_DIR, "about-this-data.tsx"),
      "utf8",
    );
    expect(about).toContain('from "@/components/politicians/compliance"');
    expect(about).not.toMatch(/^\s*["']use client["']/m);
  });
});
