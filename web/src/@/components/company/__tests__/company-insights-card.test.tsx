import { render, screen, fireEvent } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompanyInsightsCard } from "../company-insights-card";
import { pickCompanyInsights } from "../company-insights-data";
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

// What each part of the card says, and the sections the accordion holds.
const SUMMARY = /major Australian conglomerate/i;
const HISTORY = /Founded in 1914/i;
const ADVANTAGES = /Strong brand portfolio/i;
const RISK = /Exposure to retail sector volatility/i;
const DEVELOPMENTS = /expansion of Bunnings stores/i;
const PERSON = "Rob Scott";
const SECTION_LABELS = [
  "History",
  "Competitive advantages",
  "Risk factors",
  "Recent developments",
  "Key people",
];

// The accordion: a trigger's heading, that heading's item, then the item's
// parent. Radix renders them as h3 > button, div, div, and so does the
// behavioural mock in src/test/setup.ts, which replaces the package in Jest.
function accordionRoot(): HTMLElement {
  const heading = screen.getByRole("button", { name: /^History/ }).closest("h3");
  const root = heading?.parentElement?.parentElement;
  if (!root) throw new Error("the History trigger is not inside an accordion");
  return root;
}

// A section's body is rendered only while its item is open, by Radix (a closed
// item is an empty hidden region) and by the mock alike. So a body that is
// absent is a section that is closed.
const BODIES = [HISTORY, ADVANTAGES, RISK, DEVELOPMENTS];

describe("CompanyInsightsCard", () => {
  it("renders the card header with tags", () => {
    render(<CompanyInsightsCard data={mockEnrichedData} />);

    expect(screen.getByText("Company")).toBeInTheDocument();
    expect(screen.getByText("conglomerate")).toBeInTheDocument();
    expect(screen.getByText("retail")).toBeInTheDocument();
    expect(screen.getByText("home improvement")).toBeInTheDocument();
  });

  it("renders one accordion trigger per populated section, and none for the summary", () => {
    render(<CompanyInsightsCard data={mockEnrichedData} />);

    for (const label of SECTION_LABELS) {
      expect(screen.getByRole("button", { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    }
    expect(screen.getAllByRole("button")).toHaveLength(SECTION_LABELS.length);
    expect(screen.queryByRole("button", { name: /overview/i })).toBeNull();
  });

  it("sections are collapsed by default and expand on click", () => {
    render(<CompanyInsightsCard data={mockEnrichedData} />);

    expect(screen.queryByText(HISTORY)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("History"));
    expect(screen.getByText(HISTORY)).toBeInTheDocument();
  });

  // The Overview's About card clamps the description to three lines and links
  // to this tab for the rest, so the summary is the first thing on the card. It
  // is a paragraph and not an accordion item: an item open on load sits at zero
  // height and then jumps open (see "server markup" below).
  it("shows the enhanced summary as a paragraph, with no click", () => {
    render(<CompanyInsightsCard data={mockEnrichedData} />);

    const summary = screen.getByText(SUMMARY);
    expect(summary).toBeVisible();
    expect(summary.tagName).toBe("P");
  });

  it("keeps the summary out of the accordion, directly above it", () => {
    render(<CompanyInsightsCard data={mockEnrichedData} />);

    const summary = screen.getByText(SUMMARY);
    const accordion = accordionRoot();
    expect(accordion).not.toContainElement(summary);
    expect(summary.parentElement).toBe(accordion.parentElement);
    expect(summary.nextElementSibling).toBe(accordion);

    // The helper does find the accordion: a section's body, once opened, is in it.
    fireEvent.click(screen.getByText("History"));
    expect(accordionRoot()).toContainElement(screen.getByText(HISTORY));
  });

  it("divides the summary from the sections beneath it", () => {
    render(<CompanyInsightsCard data={mockEnrichedData} />);

    expect(screen.getByText(SUMMARY)).toHaveClass("border-b", "pb-4");
  });

  it("starts with every accordion section closed, and none open", () => {
    render(<CompanyInsightsCard data={mockEnrichedData} />);

    expect(screen.getAllByRole("button")).toHaveLength(SECTION_LABELS.length);
    for (const body of BODIES) {
      expect(screen.queryByText(body)).not.toBeInTheDocument();
    }
    expect(screen.queryByText(PERSON)).not.toBeInTheDocument();
  });

  it("opens one section without touching the summary", () => {
    render(<CompanyInsightsCard data={mockEnrichedData} />);

    fireEvent.click(screen.getByText("History"));

    expect(screen.getByText(HISTORY)).toBeInTheDocument();
    expect(screen.getByText(SUMMARY)).toBeVisible();
    expect(screen.queryByText(ADVANTAGES)).not.toBeInTheDocument();
  });

  it("lets several sections be open side by side", () => {
    render(<CompanyInsightsCard data={mockEnrichedData} />);

    fireEvent.click(screen.getByText("History"));
    fireEvent.click(screen.getByText("Risk factors"));

    expect(screen.getByText(HISTORY)).toBeInTheDocument();
    expect(screen.getByText(RISK)).toBeInTheDocument();
  });

  // An accordion item the server sends open animates in (animate-accordion-down)
  // from zero height to --radix-accordion-content-height, which Radix sets only
  // in the browser once it has hydrated. Until then the item sits at zero
  // height and jumps to its full height about 100ms after the first paint,
  // moving every row beneath it: 84px on the Company tab, a layout shift of
  // 0.136 on desktop. So the summary is outside the accordion, and no section
  // is open in the markup the server sends: that markup, mounted as it is
  // before React has touched it, is what these read.
  describe("server markup", () => {
    function mountServerHtml() {
      const html = renderToStaticMarkup(<CompanyInsightsCard data={mockEnrichedData} />);
      return render(<div dangerouslySetInnerHTML={{ __html: html }} />);
    }

    it("has the summary in it, outside the accordion and directly above it", () => {
      mountServerHtml();

      const summary = screen.getByText(SUMMARY);
      const accordion = accordionRoot();
      expect(summary.tagName).toBe("P");
      expect(accordion).not.toContainElement(summary);
      expect(summary.nextElementSibling).toBe(accordion);
    });

    it("has every section closed in it: no section's body is in the markup", () => {
      mountServerHtml();

      expect(screen.getAllByRole("button")).toHaveLength(SECTION_LABELS.length);
      for (const body of BODIES) {
        expect(screen.queryByText(body)).not.toBeInTheDocument();
      }
      expect(screen.queryByText(PERSON)).not.toBeInTheDocument();
    });
  });

  it("still renders its sections, all closed, when there is no summary", () => {
    render(<CompanyInsightsCard data={{ ...mockEnrichedData, enhanced_summary: null }} />);

    expect(screen.queryByText(SUMMARY)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(SECTION_LABELS.length);
    for (const body of BODIES) {
      expect(screen.queryByText(body)).not.toBeInTheDocument();
    }
    expect(screen.queryByText(PERSON)).not.toBeInTheDocument();
    // The accordion is the first thing in the card's content, with no divider
    // or stray block above it.
    expect(accordionRoot().previousElementSibling).toBeNull();
  });

  it("draws no divider and no accordion when the summary is all there is", () => {
    render(
      <CompanyInsightsCard
        data={{
          ...mockEnrichedData,
          company_history: null,
          competitive_advantages: null,
          risk_factors: [],
          recent_developments: null,
          key_people: [],
        }}
      />,
    );

    const summary = screen.getByText(SUMMARY);
    expect(summary).toBeVisible();
    expect(summary).not.toHaveClass("border-b");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("still renders a card for a summary on its own, with no tags and no sections", () => {
    const { container } = render(
      <CompanyInsightsCard
        data={{
          ...mockEnrichedData,
          tags: [],
          company_history: null,
          competitive_advantages: null,
          risk_factors: [],
          recent_developments: null,
          key_people: [],
        }}
      />,
    );

    expect(container).not.toBeEmptyDOMElement();
    expect(screen.getByText(SUMMARY)).toBeVisible();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
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

    expect(screen.getByText(SUMMARY)).toBeInTheDocument();
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

describe("pickCompanyInsights", () => {
  it("passes only the fields the card reads, never the statements JSONB", () => {
    const heavy: EnrichedCompanyMetadata = {
      ...mockEnrichedData,
      financial_reports: [
        { title: "Annual Report", date: "2025-08-20", type: "annual_report", url: "https://x/a.pdf" },
      ],
      financial_statements: {
        stock_code: "WES",
        success: true,
        annual: {
          income_statement: {
            "2025-06-30": { "Total Revenue": 44_000_000_000 },
          },
        },
        info: { market_cap: 90_000_000_000 },
      },
    };
    const picked = pickCompanyInsights(heavy);
    expect(Object.keys(picked).sort()).toEqual(
      [
        "company_history",
        "company_name",
        "competitive_advantages",
        "enhanced_summary",
        "key_people",
        "recent_developments",
        "risk_factors",
        "tags",
      ].sort(),
    );
    const serialised = JSON.stringify(picked);
    expect(serialised).not.toContain("Total Revenue");
    expect(serialised).not.toContain("financial_statements");
    expect(serialised).not.toContain("financial_reports");

    // The card renders the same from the picked fields alone.
    render(<CompanyInsightsCard data={picked} />);
    expect(screen.getByText("conglomerate")).toBeInTheDocument();
    expect(screen.getByText("Key people")).toBeInTheDocument();
  });
});
