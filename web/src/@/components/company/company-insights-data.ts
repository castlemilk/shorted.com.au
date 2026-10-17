import type { EnrichedCompanyMetadata } from "~/@/types/company-metadata";

// The fields CompanyInsightsCard reads, and the ONE place they are picked.
//
// Not a client module on purpose: the server section calls pickCompanyInsights
// before crossing into the "use client" card, and a function exported from a
// "use client" file is a client reference on the server (calling it throws).
// Only these fields reach the RSC payload; the enriched record's ~32 KB
// financial_statements JSONB (and every other unread field) stays behind.

export type CompanyInsightsData = Pick<
  EnrichedCompanyMetadata,
  | "company_name"
  | "tags"
  | "enhanced_summary"
  | "company_history"
  | "competitive_advantages"
  | "risk_factors"
  | "recent_developments"
  | "key_people"
>;

export function pickCompanyInsights(
  data: EnrichedCompanyMetadata,
): CompanyInsightsData {
  return {
    company_name: data.company_name,
    tags: data.tags ?? [],
    enhanced_summary: data.enhanced_summary,
    company_history: data.company_history,
    competitive_advantages: data.competitive_advantages,
    risk_factors: data.risk_factors ?? [],
    recent_developments: data.recent_developments,
    key_people: data.key_people ?? [],
  };
}
