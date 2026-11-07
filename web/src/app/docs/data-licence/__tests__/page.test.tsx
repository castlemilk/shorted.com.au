import { render, screen } from "@testing-library/react";

import DataLicencePage, { metadata, revalidate } from "../page";
import { STEERED_CRAWLERS } from "~/@/lib/seo/crawl-policy";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

describe("/docs/data-licence", () => {
  it("is a cached static page with a canonical", () => {
    expect(revalidate).toBe(86400);
    expect(metadata.alternates?.canonical).toBe("https://shorted.com.au/docs/data-licence");
    expect(metadata.robots).toBeUndefined();
  });

  it("names every steered crawler and the ways in", () => {
    render(<DataLicencePage />);
    for (const agent of STEERED_CRAWLERS) {
      expect(screen.getByText(agent)).toBeInTheDocument();
    }
    for (const href of ["/docs/api", "/docs/mcp.md", "/data", "/feed.xml", "/robots.txt", "/ai.txt", "/llms.txt", "/terms"]) {
      expect(
        screen.getAllByRole("link").some((l) => l.getAttribute("href") === href),
      ).toBe(true);
    }
    expect(screen.getByRole("link", { name: "support@shorted.com.au" })).toHaveAttribute(
      "href",
      "mailto:support@shorted.com.au",
    );
  });
});
