/** @jest-environment-options {"url":"https://shorted.com.au/signup?email=private%40example.com&callbackUrl=secret#token"} */
import { trackSignupComplete } from "../signup-analytics";

afterEach(() => { delete window.gtag; });

it.each(["email", "google"] as const)("sends sign_up for %s without identity or auth URLs", (method) => {
  const gtag = jest.fn();
  window.gtag = gtag;
  jest.spyOn(document, "referrer", "get").mockReturnValue("https://example.com/user/private?token=secret#fragment");
  trackSignupComplete(method);
  expect(gtag).toHaveBeenCalledWith("event", "sign_up", {
    method, surface: "/signup", page_location: "https://shorted.com.au/signup", page_referrer: "https://example.com",
  });
  expect(JSON.stringify(gtag.mock.calls)).not.toMatch(/private|secret|token|callbackUrl|@/);
  jest.restoreAllMocks();
});

it("ignores unknown methods and remains safe without GA", () => {
  expect(() => trackSignupComplete("email")).not.toThrow();
  const gtag = jest.fn();
  window.gtag = gtag;
  // @ts-expect-error Untrusted runtime callers cannot forward arbitrary strings.
  trackSignupComplete("private@example.com");
  expect(gtag).not.toHaveBeenCalled();
});
