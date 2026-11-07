import { render, screen, within } from "@testing-library/react";
import { useSession } from "next-auth/react";

import SiteFooter from "../site-footer";

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));

const mockUseSession = useSession as jest.Mock;

/** The footer's anchor for a destination. */
const footerLink = (href: string) =>
  screen.getAllByRole("link").find((link) => link.getAttribute("href") === href);

// Signed out, /dashboards and /portfolio 307 to the noindexed /signin, and the
// footer linked them, followable, from 46 of the 47 pages probed on 2026-10-21.
// SSR has no session, so the signed-out render is the one crawlers read.
describe("SiteFooter auth-only links", () => {
  afterEach(() => mockUseSession.mockReset());

  it("marks the auth-only links nofollow for a signed-out visitor", () => {
    mockUseSession.mockReturnValue({ data: null, status: "unauthenticated" });
    render(<SiteFooter />);

    for (const href of ["/dashboards", "/portfolio"]) {
      expect(footerLink(href)).toHaveAttribute("rel", "nofollow");
    }
    // Public pages stay followed.
    for (const href of ["/top", "/industry-intelligence", "/roadmap", "/data"]) {
      expect(footerLink(href)).not.toHaveAttribute("rel");
    }
  });

  it("follows them for a signed-in visitor", () => {
    mockUseSession.mockReturnValue({
      data: { user: { id: "u1" } },
      status: "authenticated",
    });
    render(<SiteFooter />);

    expect(footerLink("/dashboards")).not.toHaveAttribute("rel");
    expect(footerLink("/portfolio")).not.toHaveAttribute("rel");
  });
});

describe("SiteFooter socials", () => {
  beforeEach(() =>
    mockUseSession.mockReturnValue({ data: null, status: "unauthenticated" }),
  );
  afterEach(() => mockUseSession.mockReset());

  it("links the founder's LinkedIn, X, blog and GitHub as named profiles", () => {
    render(<SiteFooter />);

    const founder = screen.getByRole("list", { name: "Ben Ebsworth on the web" });
    const links = within(founder).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "https://www.linkedin.com/in/ben-ebsworth/",
      "https://x.com/sycli",
      "https://benebsworth.com/blog/",
      "https://github.com/castlemilk",
    ]);
    expect(links.map((l) => l.getAttribute("aria-label"))).toEqual([
      "Ben Ebsworth on LinkedIn",
      "Ben Ebsworth on X (@sycli)",
      "Ben Ebsworth's blog",
      "Ben Ebsworth on GitHub",
    ]);
    for (const link of links) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener me");
    }
  });

  it("links Shorted's X account and the RSS feed", () => {
    render(<SiteFooter />);

    const brand = screen.getByRole("list", { name: "Shorted on the web" });
    expect(
      within(brand).getByRole("link", { name: "Shorted on X (@shorted___)" }),
    ).toHaveAttribute("href", "https://twitter.com/shorted___");
    const rss = within(brand).getByRole("link", { name: "RSS feed" });
    expect(rss).toHaveAttribute("href", "/feed.xml");
    expect(rss).not.toHaveAttribute("target");
  });

  it("names the founder's site from the credit line", () => {
    render(<SiteFooter />);
    expect(screen.getByRole("link", { name: "Ben Ebsworth" })).toHaveAttribute(
      "href",
      "https://benebsworth.com",
    );
  });
});
