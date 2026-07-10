import { describe, it, expect } from "@jest/globals";
import { render, screen, fireEvent } from "@testing-library/react";
import { CompanyInsightsCard } from "../company-insights-card";
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
  key_people: [
    {
      name: "Rob Scott",
      role: "Managing Director",
      bio: "Leads the group strategy.",
    },
  ],
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

describe("CompanyInsightsCard", () => {
  it("renders the card header with tags", () => {
    render(<CompanyInsightsCard data={mockEnrichedData} />);

    expect(screen.getByText("Company")).toBeInTheDocument();
    expect(screen.getByText("conglomerate")).toBeInTheDocument();
    expect(screen.getByText("retail")).toBeInTheDocument();
    expect(screen.getByText("home improvement")).toBeInTheDocument();
  });

  it("renders one accordion trigger per populated section", () => {
    render(<CompanyInsightsCard data={mockEnrichedData} />);

    expect(screen.getByText("Overview")).toBeInTheDocument();
    expect(screen.getByText("History")).toBeInTheDocument();
    expect(screen.getByText("Competitive advantages")).toBeInTheDocument();
    expect(screen.getByText("Risk factors")).toBeInTheDocument();
    expect(screen.getByText("Recent developments")).toBeInTheDocument();
    expect(screen.getByText("Key people")).toBeInTheDocument();
  });

  it("sections are collapsed by default and expand on click", () => {
    render(<CompanyInsightsCard data={mockEnrichedData} />);

    expect(
      screen.queryByText(/Founded in 1914/i),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("History"));
    expect(screen.getByText(/Founded in 1914/i)).toBeInTheDocument();
  });

  it("expands risk factors with all items", () => {
    render(<CompanyInsightsCard data={mockEnrichedData} />);

    fireEvent.click(screen.getByText("Risk factors"));
    expect(
      screen.getByText(/Exposure to retail sector volatility/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Competition from online retailers/i),
    ).toBeInTheDocument();
  });

  it("expands key people with the leadership list", () => {
    render(<CompanyInsightsCard data={mockEnrichedData} />);

    fireEvent.click(screen.getByText("Key people"));
    expect(screen.getByText("Rob Scott")).toBeInTheDocument();
    expect(screen.getByText("Managing Director")).toBeInTheDocument();
  });

  it("omits sections when data is missing", () => {
    const minimalData: EnrichedCompanyMetadata = {
      ...mockEnrichedData,
      key_people: [],
      company_history: null,
      competitive_advantages: null,
      risk_factors: [],
      recent_developments: null,
    };

    render(<CompanyInsightsCard data={minimalData} />);

    expect(screen.getByText("Overview")).toBeInTheDocument();
    expect(screen.queryByText("History")).not.toBeInTheDocument();
    expect(screen.queryByText("Risk factors")).not.toBeInTheDocument();
    expect(screen.queryByText("Key people")).not.toBeInTheDocument();
  });

  it("returns null when there is no content at all", () => {
    const emptyData: EnrichedCompanyMetadata = {
      ...mockEnrichedData,
      tags: [],
      enhanced_summary: null,
      company_history: null,
      competitive_advantages: null,
      risk_factors: [],
      recent_developments: null,
      key_people: [],
    };

    const { container } = render(<CompanyInsightsCard data={emptyData} />);
    expect(container).toBeEmptyDOMElement();
  });
});
