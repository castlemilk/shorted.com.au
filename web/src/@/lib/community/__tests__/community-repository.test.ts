describe("community repository selection", () => {
  const originalCommunityStoreDriver = process.env.COMMUNITY_STORE_DRIVER;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalPostgresUrl = process.env.POSTGRES_URL;

  afterEach(() => {
    jest.resetModules();
    for (const [key, value] of Object.entries({
      COMMUNITY_STORE_DRIVER: originalCommunityStoreDriver,
      DATABASE_URL: originalDatabaseUrl,
      POSTGRES_URL: originalPostgresUrl,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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

  it("fails closed instead of switching data stores when selected Postgres is unconfigured", async () => {
    process.env.COMMUNITY_STORE_DRIVER = "postgres";
    delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_URL;

    const { getCommunityStore } = await import("../community-repository");

    expect(() => getCommunityStore()).toThrow(/COMMUNITY_STORE_DRIVER=postgres/);
  });

  it("accepts POSTGRES_URL when DATABASE_URL is absent", async () => {
    process.env.COMMUNITY_STORE_DRIVER = "postgres";
    delete process.env.DATABASE_URL;
    process.env.POSTGRES_URL = "postgresql://example.test/shorted";
    const { getCommunityStore } = await import("../community-repository");
    const { postgresCommunityStore } = await import("../postgres-community");

    expect(getCommunityStore()).toBe(postgresCommunityStore);
  });
});
