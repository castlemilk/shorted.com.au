const KEY = "ab".repeat(32);
const OTHER = "cd".repeat(32);

function load(file: {
  applicationId: string;
  publicKey: string;
  activity: boolean;
}) {
  let mod!: typeof import("../config");
  jest.isolateModules(() => {
    jest.doMock("~/config/discord-app.json", () => file);
    mod = jest.requireActual<typeof import("../config")>("../config");
  });
  return mod;
}

describe("Discord app config", () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
    delete process.env.DISCORD_PUBLIC_KEY;
    delete process.env.DISCORD_ACTIVITY_ENABLED;
  });

  afterAll(() => {
    process.env = env;
  });

  it("is unconfigured while the committed file is empty", () => {
    const config = load({ applicationId: "", publicKey: "", activity: false });
    expect(config.discordPublicKey()).toBeNull();
    expect(config.discordActivityEnabled()).toBe(false);
  });

  it("reads the committed app", () => {
    const config = load({
      applicationId: "1",
      publicKey: KEY.toUpperCase(),
      activity: true,
    });
    expect(config.discordPublicKey()).toBe(KEY);
    expect(config.discordActivityEnabled()).toBe(true);
  });

  it("lets the environment point a deployment at another app", () => {
    process.env.DISCORD_PUBLIC_KEY = `${OTHER}\\n`;
    process.env.DISCORD_ACTIVITY_ENABLED = "false";
    const config = load({ applicationId: "1", publicKey: KEY, activity: true });
    expect(config.discordPublicKey()).toBe(OTHER);
    expect(config.discordActivityEnabled()).toBe(false);
  });

  it("offers install links only for a real application id", () => {
    const empty = { applicationId: "", publicKey: "", activity: false };
    expect(load(empty).discordApplicationId()).toBeNull();
    expect(
      load({ ...empty, applicationId: "1234" }).discordApplicationId(),
    ).toBeNull();
    expect(
      load({
        ...empty,
        applicationId: "1290000000000000000",
      }).discordApplicationId(),
    ).toBe("1290000000000000000");
  });

  it("refuses a malformed key rather than verifying against it", () => {
    process.env.DISCORD_PUBLIC_KEY = "not-a-key";
    expect(
      load({
        applicationId: "",
        publicKey: "",
        activity: false,
      }).discordPublicKey(),
    ).toBeNull();
  });
});
