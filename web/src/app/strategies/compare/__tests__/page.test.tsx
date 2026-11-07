import { metadata } from "../page";

// The compare page is private (robots.txt disallows it): it must stay out of the index, and
// its canonical must name itself.
describe("the compare page's metadata", () => {
  it("is noindex and follows its links, with a canonical of its own URL", () => {
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBe("https://shorted.com.au/strategies/compare");
  });
});
