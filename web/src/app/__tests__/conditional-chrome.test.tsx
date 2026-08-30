import { render } from "@testing-library/react";

const mockPathname = { value: "/" };

jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname.value,
}));

jest.mock("~/@/components/ui/site-header", () => ({
  __esModule: true,
  default: () => <header data-testid="site-header">header</header>,
}));

jest.mock("~/@/components/ui/site-footer", () => ({
  __esModule: true,
  default: () => <footer data-testid="site-footer">footer</footer>,
}));

import { ConditionalHeader } from "../conditional-header";
import { ConditionalFooter } from "../conditional-footer";

function chromeOn(pathname: string) {
  mockPathname.value = pathname;
  const header = render(<ConditionalHeader />);
  const footer = render(<ConditionalFooter />);
  const result = {
    header: !!header.queryByTestId("site-header"),
    footer: !!footer.queryByTestId("site-footer"),
  };
  header.unmount();
  footer.unmount();
  return result;
}

// The OAuth flow renders without site chrome. A consent screen is a decision,
// and a nav bar full of links beside it is an invitation to wander off
// mid-authorisation — which is why Google, GitHub and Slack all render theirs
// bare. It is also a layout dependency: the success screen uses min-h-screen,
// which is only correct while nothing else contributes height.
describe("site chrome on the OAuth flow", () => {
  it("is absent on the consent route", () => {
    expect(chromeOn("/oauth/authorize")).toEqual({
      header: false,
      footer: false,
    });
  });

  // Scoped to "/oauth/" with the slash, so a future top-level route that merely
  // starts with those letters does not silently lose its chrome.
  it("does not swallow a route that merely starts the same way", () => {
    expect(chromeOn("/oauthenticated")).toEqual({ header: true, footer: true });
    expect(chromeOn("/oauth-help")).toEqual({ header: true, footer: true });
  });

  // Sign-in KEEPS its chrome, deliberately. It is an ordinary site page, and
  // the header is a place the brand is visible while someone types a password.
  it("is present on sign-in, which is part of the site", () => {
    expect(chromeOn("/signin")).toEqual({ header: true, footer: true });
  });

  it("leaves the rest of the site alone", () => {
    for (const path of ["/", "/top", "/housing", "/politicians"]) {
      expect(chromeOn(path)).toEqual({ header: true, footer: true });
    }
  });

  // The pre-existing exclusions must survive this change.
  it("keeps the embed and roadmap rules", () => {
    expect(chromeOn("/embed/chart")).toEqual({ header: false, footer: false });
    // Roadmap drops only the footer, so it can use the space below the nav.
    expect(chromeOn("/roadmap")).toEqual({ header: true, footer: false });
  });
});
