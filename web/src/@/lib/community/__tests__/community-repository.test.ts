describe("community repository selection", () => {
  const originalCommunityStoreDriver = process.env.COMMUNITY_STORE_DRIVER;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    jest.resetModules();
    process.env.COMMUNITY_STORE_DRIVER = originalCommunityStoreDriver;
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("keeps Firestore as the default store", async () => {
    delete process.env.COMMUNITY_STORE_DRIVER;
    delete process.env.DATABASE_URL;

    const { getCommunityStore } = await import("../community-repository");
    const { firestoreCommunityStore } = await import("../firestore-community");

    expect(getCommunityStore()).toBe(firestoreCommunityStore);
  });

  it("selects Postgres only when explicitly enabled and configured", async () => {
    process.env.COMMUNITY_STORE_DRIVER = "postgres";
    process.env.DATABASE_URL = "postgresql://example.test/shorted";

    const { getCommunityStore } = await import("../community-repository");
    const { postgresCommunityStore } = await import("../postgres-community");

    expect(getCommunityStore()).toBe(postgresCommunityStore);
  });

  it("falls back to Firestore when Postgres is enabled without DATABASE_URL", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.COMMUNITY_STORE_DRIVER = "postgres";
    delete process.env.DATABASE_URL;

    const { getCommunityStore } = await import("../community-repository");
    const { firestoreCommunityStore } = await import("../firestore-community");

    expect(getCommunityStore()).toBe(firestoreCommunityStore);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("COMMUNITY_STORE_DRIVER=postgres"),
    );

    warnSpy.mockRestore();
  });
});
