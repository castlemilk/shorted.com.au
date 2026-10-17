import { stripLeadingHeading } from "../body";

describe("stripLeadingHeading", () => {
  it("removes exactly one leading H1 and the blank lines after it", () => {
    expect(
      stripLeadingHeading("# Title\n\nFirst paragraph.\n\n## Section\n"),
    ).toBe("First paragraph.\n\n## Section\n");
    expect(stripLeadingHeading("\n\n# Title\r\n\r\nBody")).toBe("Body");
  });

  it("leaves a body that does not open with an H1 alone", () => {
    expect(stripLeadingHeading("Intro paragraph.\n\n# Later heading\n")).toBe(
      "Intro paragraph.\n\n# Later heading\n",
    );
    expect(stripLeadingHeading("## Section first\n\nBody")).toBe(
      "## Section first\n\nBody",
    );
    expect(stripLeadingHeading("#hashtag not a heading\n")).toBe(
      "#hashtag not a heading\n",
    );
    expect(stripLeadingHeading("")).toBe("");
  });
});
