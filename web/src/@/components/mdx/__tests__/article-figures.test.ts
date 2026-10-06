/** @jest-environment node */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

describe("server article figures with the real safe MDX compiler", () => {
  it("retains blog data, Markdown tables and nested steps without a client renderer", () => {
    // Run the ESM MDX dependency with Node's native loader. Mocking compileMDX
    // here would miss the JavaScript-expression stripping that caused lost rows.
    const output = execFileSync(process.execPath, [
      "--import", "tsx", resolve(__dirname, "article-figures.rsc-check.tsx"),
    ], { cwd: resolve(__dirname, "../../../../../"), encoding: "utf8" });
    expect(JSON.parse(output)).toMatchObject({ blogs: expect.any(Number) });
  }, 30_000);
});
