import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CompanyOverview } from "../company-overview";
import type { EnrichedCompanyMetadata } from "~/@/types/company-metadata";

const mockEnrichedData: EnrichedCompanyMetadata = {
  stock_code: "WES",
  company_name: "WESFARMERS LIMITED",
  industry: "Retail",
  logo_url: null,
  logo_gcs_url: "https://storage.googleapis.com/logos/WES.svg",
  website: "https://www.wesfarmers.com.au",
  description: null,
  tags: ["conglomerate", "retail", "home improvement", "chemicals"],
  enhanced_summary:
    "Wesfarmers Limited is a major Australian conglomerate with diversified revenue streams across retail, industrial products, and chemicals.",
  company_history:
    "Founded in 1914 as a farmers' cooperative, Wesfarmers has grown into one of Australia's largest companies.",
  key_people: [],
  financial_reports: [],
  competitive_advantages:
    "Strong brand portfolio including Bunnings, Kmart, and Officeworks. Diversified business model provides stability.",
  risk_factors: [
    "Exposure to retail sector volatility",
    "Competition from online retailers",
    "Regulatory changes in chemicals division",
  ],
  recent_developments:
    "Recently announced expansion of Bunnings stores and investment in digital capabilities.",
  social_media_links: {
    linkedin: "https://linkedin.com/company/wesfarmers",
    twitter: "https://twitter.com/wesfarmers",
  },
  financial_statements: null,
  enrichment_status: "completed",
  enrichment_date: "2024-01-15T10:00:00Z",
  enrichment_error: null,
};

describe("CompanyOverview", () => {
  it("should render tags section when tags are present", () => {
    render(<CompanyOverview data={mockEnrichedData} />);

    expect(screen.getByText("Industry & Focus")).toBeInTheDocument();
    expect(screen.getByText("conglomerate")).toBeInTheDocument();
    expect(screen.getByText("retail")).toBeInTheDocument();
    expect(screen.getByText("home improvement")).toBeInTheDocument();
  });

  it("should render enhanced summary when present", () => {
    render(<CompanyOverview data={mockEnrichedData} />);

    expect(screen.getByText("Company Overview")).toBeInTheDocument();
    expect(
      screen.getByText(/major Australian conglomerate/i)
    ).toBeInTheDocument();
  });

  it("should render company history when present", () => {
    render(<CompanyOverview data={mockEnrichedData} />);

    expect(screen.getByText("Company History")).toBeInTheDocument();
    expect(screen.getByText(/Founded in 1914/i)).toBeInTheDocument();
  });

  it("should render competitive advantages when present", () => {
    render(<CompanyOverview data={mockEnrichedData} />);

    expect(screen.getByText("Competitive Advantages")).toBeInTheDocument();
    expect(
      screen.getByText(/Strong brand portfolio/i)
    ).toBeInTheDocument();
  });

  it("should render risk factors when present", () => {
    render(<CompanyOverview data={mockEnrichedData} />);

    expect(screen.getByText("Risk Factors")).toBeInTheDocument();
    expect(
      screen.getByText(/Exposure to retail sector volatility/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Competition from online retailers/i)
    ).toBeInTheDocument();
  });

  it("should render recent developments when present", () => {
    render(<CompanyOverview data={mockEnrichedData} />);

    expect(screen.getByText("Recent Developments")).toBeInTheDocument();
    expect(screen.getByText(/expansion of Bunnings/i)).toBeInTheDocument();
  });

  it("should not render sections when data is missing", () => {
    const minimalData: EnrichedCompanyMetadata = {
      ...mockEnrichedData,
      tags: [],
      enhanced_summary: null,
      company_history: null,
      competitive_advantages: null,
      risk_factors: [],
      recent_developments: null,
    };

    const { container } = render(<CompanyOverview data={minimalData} />);

    // Should render empty or minimal content
    expect(container.querySelector(".space-y-6")).toBeEmptyDOMElement();
  });

  it("should render all sections with correct styling", () => {
    render(<CompanyOverview data={mockEnrichedData} />);

    // Check for specific colored borders on cards
    const competitiveAdvCard = screen.getByText("Competitive Advantages").closest("div");
    expect(competitiveAdvCard).toHaveClass("border-l-4", "border-l-green-500");

    const riskCard = screen.getByText("Risk Factors").closest("div");
    expect(riskCard).toHaveClass("border-l-4", "border-l-amber-500");

    const recentDevCard = screen.getByText("Recent Developments").closest("div");
    expect(recentDevCard).toHaveClass("border-l-4", "border-l-blue-500");
  });
});

