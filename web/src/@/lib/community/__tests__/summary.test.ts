import { buildCommunitySummary } from "~/@/lib/community/summary";

describe("buildCommunitySummary", () => {
  it("returns compact empty-state teaser copy when no activity exists", () => {
    expect(buildCommunitySummary({ threads: [], pulse: [] }).headline).toMatch(
      /first to discuss/i,
    );
  });
});
