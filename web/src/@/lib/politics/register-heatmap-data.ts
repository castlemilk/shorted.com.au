import { industryLabel } from "../industry-placeholder";

interface AnalyticsCell {
  partyAb: string;
  industry: string;
  people: number;
  companies: number;
}

interface AnalyticsAxis {
  industry: string;
  people: number;
  companies: number;
}

interface AnalyticsParty {
  partyAb: string;
  people: number;
}

/**
 * The party x industry heatmap's props, from the analytics rpc: plain objects
 * holding only what the island reads (a generated message does not cross into
 * a client component), and no ASX placeholder. Funds and trusts the ASX has
 * not classified share "Not Applic" or "Class Pend", which are not industries:
 * the island draws no row for them and lets none set its scale, and dropping
 * them here keeps them out of the page's payload as well.
 */
export function registerHeatmapProps(
  analytics:
    | {
        cells: AnalyticsCell[];
        industries: AnalyticsAxis[];
        parties: AnalyticsParty[];
        industriesOmitted: number;
      }
    | undefined,
) {
  return {
    cells: (analytics?.cells ?? [])
      .filter((c) => industryLabel(c.industry))
      .map((c) => ({
        partyAb: c.partyAb,
        industry: c.industry,
        people: c.people,
        companies: c.companies,
      })),
    industries: (analytics?.industries ?? [])
      .filter((i) => industryLabel(i.industry))
      .map((i) => ({
        industry: i.industry,
        people: i.people,
        companies: i.companies,
      })),
    parties: (analytics?.parties ?? []).map((p) => ({
      partyAb: p.partyAb,
      people: p.people,
    })),
    industriesOmitted: analytics?.industriesOmitted ?? 0,
  };
}
