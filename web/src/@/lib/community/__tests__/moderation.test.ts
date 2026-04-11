import { moderateCommunityText } from "~/@/lib/community/moderation";

describe("moderateCommunityText", () => {
  it("flags suspicious invite-to-spam content", () => {
    expect(moderateCommunityText("join my discord and buy now").status).toBe(
      "needs_review",
    );
  });
});
