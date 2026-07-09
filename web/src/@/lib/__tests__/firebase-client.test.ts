describe("firebase client env normalization", () => {
  it("removes escaped newline suffixes from public config values", async () => {
    const { normalizeFirebasePublicConfigValue } = await import(
      "~/@/lib/firebase-public-config"
    );

    expect(normalizeFirebasePublicConfigValue("AIza-valid-key\\n")).toBe(
      "AIza-valid-key",
    );
  });
});
