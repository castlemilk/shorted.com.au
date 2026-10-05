import { authPageHref, safeAuthCallbackUrl } from "../auth-redirect";

describe("authentication callbacks", () => {
  it("preserves local destinations and OAuth callback parameters", () => {
    const callback =
      "/oauth/authorize?client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A51763%2Fcb";
    expect(safeAuthCallbackUrl(callback)).toBe(callback);
    expect(safeAuthCallbackUrl("/portfolio?tab=watchlist#recent")).toBe(
      "/portfolio?tab=watchlist#recent",
    );
    const signup = new URL(
      authPageHref("/signup", callback),
      "https://shorted.com.au",
    );
    expect(signup.pathname).toBe("/signup");
    expect(signup.searchParams.get("callbackUrl")).toBe(callback);
  });

  it.each([
    undefined,
    null,
    "",
    "https://evil.example/",
    "javascript:alert(1)",
    "//evil.example/",
    "/\\evil.example/",
    "/\n/evil.example/",
    " /portfolio",
  ])("uses the home page for unsafe callback %p", (callback) => {
    expect(safeAuthCallbackUrl(callback)).toBe("/");
  });

  it("keeps the ordinary auth links short when going to the home page", () => {
    expect(authPageHref("/signin", "/")).toBe("/signin");
    expect(authPageHref("/signup", "https://evil.example/")).toBe("/signup");
  });

  it("converts an absolute referer on the current browser origin to a local path", () => {
    expect(
      safeAuthCallbackUrl(
        `${window.location.origin}/portfolio?tab=watchlist#recent`,
      ),
    ).toBe("/portfolio?tab=watchlist#recent");
    expect(
      safeAuthCallbackUrl(
        "https://shorted.com.au/oauth/authorize?client_id=abc",
        "https://shorted.com.au",
      ),
    ).toBe("/oauth/authorize?client_id=abc");
  });

  it.each([
    "https://www.shorted.com.au/portfolio",
    "http://shorted.com.au/portfolio",
    "https://shorted.com.au.evil.example/portfolio",
    "blob:https://shorted.com.au/token",
    "portfolio",
  ])("rejects nonlocal absolute callbacks and relative path %p", (callback) => {
    expect(safeAuthCallbackUrl(callback, "https://shorted.com.au")).toBe("/");
  });

  it.each([
    "/signin",
    "/signin/",
    "/signin///?callbackUrl=%2Fportfolio",
    "/signup",
    "/signup/",
    "/portfolio/../signin",
    "https://shorted.com.au/signup?callbackUrl=%2Fportfolio",
  ])("avoids redirect loops back to an authentication page %p", (callback) => {
    expect(safeAuthCallbackUrl(callback, "https://shorted.com.au")).toBe("/");
  });
});
