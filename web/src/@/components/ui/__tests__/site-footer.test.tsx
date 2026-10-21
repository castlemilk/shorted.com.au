import { render, screen } from "@testing-library/react";
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
