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
});
