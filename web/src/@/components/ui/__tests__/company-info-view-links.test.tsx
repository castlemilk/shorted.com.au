import { create } from "@bufbuild/protobuf";
import { render, screen, within } from "@testing-library/react";
import {
  SocialMediaLinksSchema,
  StockDetailsSchema,
} from "~/gen/stocks/v1alpha1/stocks_pb";
import { CompanyInfoView } from "../company-info-view";

/**
 * The Company details card's website and social links are scraped or
 * model-written company-metadata, and the card rendered them as hrefs as they
 * came: a `javascript:` website ran in our origin when clicked (security review
 * SEC-07). Only an http(s) URL is a link now.
 */

function details(website: string, social: Record<string, string> = {}) {
  return create(StockDetailsSchema, {
    productCode: "BHP",
    website,
    enrichmentStatus: "completed",
    socialMediaLinks: create(SocialMediaLinksSchema, social),
  });
}

const hrefs = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));

describe("the company card's website", () => {
  it("links an http(s) website, labelled with its host", () => {
    const { container } = render(<CompanyInfoView stockDetails={details("https://www.bhp.com/about")} />);

    const link = screen.getByRole("link", { name: "bhp.com" });
    expect(link).toHaveAttribute("href", "https://www.bhp.com/about");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(hrefs(container)).toEqual(["https://www.bhp.com/about"]);
  });

  it.each([
    ["javascript:alert(document.cookie)"],
    [" javascript:alert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    ["vbscript:msgbox(1)"],
    ["//evil.example"],
    ["www.bhp.com"],
  ])("shows %p as text, not a link", (website) => {
    const { container } = render(<CompanyInfoView stockDetails={details(website)} />);

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container.querySelector("a")).toBeNull();
    expect(container).toHaveTextContent(website.trim());
  });
});

describe("the company card's social links", () => {
  it("links the http(s) ones and leaves the others out", () => {
    const { container } = render(
      <CompanyInfoView
        stockDetails={details("https://www.bhp.com", {
          linkedin: "https://www.linkedin.com/company/bhp",
          twitter: "javascript:alert(1)",
          facebook: "data:text/html,<b>x</b>",
          youtube: "https://www.youtube.com/@bhp",
        })}
      />,
    );

    expect(screen.getByRole("link", { name: /LinkedIn/ })).toHaveAttribute(
      "href",
      "https://www.linkedin.com/company/bhp",
    );
    expect(screen.getByRole("link", { name: /YouTube/ })).toHaveAttribute(
      "href",
      "https://www.youtube.com/@bhp",
    );
    expect(screen.queryByRole("link", { name: /Twitter/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Facebook/ })).not.toBeInTheDocument();
    expect(hrefs(container).every((href) => href?.startsWith("https://"))).toBe(true);
  });

  it("drops the Connect row when no social link is http(s)", () => {
    render(
      <CompanyInfoView
        stockDetails={details("https://www.bhp.com", {
          linkedin: "javascript:alert(1)",
          twitter: "  vbscript:msgbox(1)",
        })}
      />,
    );

    expect(screen.queryByText("Connect")).not.toBeInTheDocument();
    expect(within(document.body).getAllByRole("link")).toHaveLength(1);
  });
});
