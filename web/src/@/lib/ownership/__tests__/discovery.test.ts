import { readFileSync } from "node:fs";
import { join } from "node:path";

// /llms.txt is the index an agent reads before any page, and /ownership
// launched (2026-10-17) without a line in it (SEO review F09, 2026-10-21).
describe("ownership discovery", () => {
  it("lists /ownership among llms.txt's key content", () => {
    const llms = readFileSync(join(process.cwd(), "public/llms.txt"), "utf8");
    const keyContent = llms.slice(llms.indexOf("## Key Content"), llms.indexOf("## Programmatic access"));
    expect(keyContent).toMatch(/^- \[[^\]]+\]\(https:\/\/shorted\.com\.au\/ownership\): \S/m);
  });

  // The extended file (/llms-full.txt, linked from the API catalog) kept the
  // pre-ownership dataset count and no line for the hub.
  it("lists /ownership among llms-full.txt's key content pages, and counts the dataset", () => {
    const full = readFileSync(join(process.cwd(), "public/llms-full.txt"), "utf8");
    const keyContent = full.slice(full.indexOf("## Key Content Pages"), full.indexOf("## Educational Resources"));
    expect(keyContent).toMatch(/^- \[[^\]]+\]\(https:\/\/shorted\.com\.au\/ownership\): \S/m);
    expect(full).toContain("four further Australian datasets alongside it: who holds ASX stocks");
  });
});
