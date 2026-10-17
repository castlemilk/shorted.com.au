import {
  forgetRememberedLogin,
  getRememberedLogin,
  rememberLogin,
  REMEMBERED_LOGIN_KEY,
} from "../remembered-login";

describe("remembered login hints", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => jest.restoreAllMocks());

  it("remembers only account hints, even if passed credentials or permissions", () => {
    rememberLogin({
      email: " trader@example.com ",
      name: "Trader",
      method: "google",
      password: "must-not-save",
      idToken: "must-not-save",
      isAdmin: true,
    } as Parameters<typeof rememberLogin>[0]);
    expect(getRememberedLogin()).toEqual({
      email: "trader@example.com",
      name: "Trader",
      image: null,
      method: "google",
    });
    expect(localStorage.getItem(REMEMBERED_LOGIN_KEY)).not.toMatch(
      /password|idToken|isAdmin|must-not-save/,
    );
  });

  it("expires hints after 30 days and purges invalid cache entries", () => {
    rememberLogin({ email: "trader@example.com", method: "password" });
    jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 30 * 24 * 60 * 60 * 1000);
    expect(getRememberedLogin()).toBeNull();
    expect(localStorage.getItem(REMEMBERED_LOGIN_KEY)).toBeNull();
    localStorage.setItem(REMEMBERED_LOGIN_KEY, "bad json");
    expect(getRememberedLogin()).toBeNull();
    expect(localStorage.getItem(REMEMBERED_LOGIN_KEY)).toBeNull();
  });

  it("rejects unrecognized versions, invalid methods, and future timestamps", () => {
    for (const overrides of [
      { version: 2 },
      { savedAt: Date.now() + 1000 },
      { account: { email: "trader@example.com", method: "token" } },
      { account: { email: "invalid", method: "google" } },
    ]) {
      localStorage.setItem(
        REMEMBERED_LOGIN_KEY,
        JSON.stringify({
          version: 1,
          savedAt: Date.now(),
          account: { email: "trader@example.com", method: "google" },
          ...overrides,
        }),
      );
      expect(getRememberedLogin()).toBeNull();
    }
  });

  it("forget removes only the login hint", () => {
    localStorage.setItem("unrelated", "keep");
    rememberLogin({ email: "trader@example.com", method: "password" });
    forgetRememberedLogin();
    expect(getRememberedLogin()).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("keep");
  });

  it("does not break login when storage is blocked", () => {
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() =>
      rememberLogin({ email: "trader@example.com", method: "google" }),
    ).not.toThrow();
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(getRememberedLogin()).toBeNull();
  });
});
