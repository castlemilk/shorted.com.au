import {
  normalizeFirebaseClientEmail,
  normalizeFirebasePrivateKey,
} from "~/@/lib/firebase-admin";

describe("firebase admin env normalization", () => {
  it("uses the first token from a malformed client email secret", () => {
    expect(
      normalizeFirebaseClientEmail(
        "firebase-admin@example-project.iam.gserviceaccount.com stale trailing text",
      ),
    ).toBe("firebase-admin@example-project.iam.gserviceaccount.com");
  });

  it("normalizes escaped private key newlines", () => {
    expect(normalizeFirebasePrivateKey("-----BEGIN-----\\nabc\\n-----END-----"))
      .toBe("-----BEGIN-----\nabc\n-----END-----");
  });
});
