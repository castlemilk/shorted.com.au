import { type ReactElement } from "react";
import type { EnrichedCompanyMetadata } from "~/@/types/company-metadata";

const mockGetEnriched = jest.fn();
jest.mock("~/app/actions/company-metadata", () => ({
  getEnrichedCompanyMetadata: (...args: unknown[]) => mockGetEnriched(...args),
}));

import { CompanyInsightsCard } from "../company-insights-card";
import { EnrichedCompanySection } from "../enriched-company-section";

// The section is a server component: Suspense around an async reader. react-dom
// 18 cannot render the reader here, so it is called the way the server would:
// take the element Suspense holds, await its function, and read what it returns.
async function settle(props: { stockCode: string; companyName?: string }) {
  const suspense = EnrichedCompanySection(props) as ReactElement<{ children: ReactElement }>;
  const reader = suspense.props.children;
  const render = reader.type as (p: unknown) => Promise<ReactElement>;
  return render(reader.props);
}

const record = (overrides: Partial<EnrichedCompanyMetadata> = {}) =>
  ({
    stock_code: "BHP",
    company_name: "Bhp Group",
    tags: [],
    enhanced_summary: "BHP is a miner.",
    risk_factors: [],
    key_people: [],
    ...overrides,
  }) as unknown as EnrichedCompanyMetadata;

describe("EnrichedCompanySection", () => {
  beforeEach(() => mockGetEnriched.mockReset());

  it("hands the card the display name the page spells, not the record's title-cased one", async () => {
    mockGetEnriched.mockResolvedValue(record());
    const card = await settle({ stockCode: "BHP", companyName: "BHP Group" });
    expect(card.type).toBe(CompanyInsightsCard);
    expect((card.props as { companyName: string }).companyName).toBe("BHP Group");
  });

  it("cleans the record's own name with the code when the page gives none", async () => {
    mockGetEnriched.mockResolvedValue(record({ company_name: "Bhp Group" }));
    const card = await settle({ stockCode: "BHP" });
    expect((card.props as { companyName: string }).companyName).toBe("BHP Group");
  });

  it("repairs the shouted ASIC form and drops the entity suffix, as the header does", async () => {
    mockGetEnriched.mockResolvedValue(record({ company_name: "BHP GROUP LIMITED" }));
    const card = await settle({ stockCode: "BHP" });
    expect((card.props as { companyName: string }).companyName).toBe("BHP Group");
  });

  it("names no company, rather than throwing or falling back to the code, for a record with no name", async () => {
    for (const company_name of [undefined as unknown as string, ""]) {
      mockGetEnriched.mockResolvedValue(record({ company_name }));
      const card = await settle({ stockCode: "BHP" });
      expect((card.props as { companyName?: string }).companyName).toBeUndefined();
    }
  });

  it("reads the record for the stock's code", async () => {
    mockGetEnriched.mockResolvedValue(record());
    await settle({ stockCode: "BHP", companyName: "BHP Group" });
    expect(mockGetEnriched).toHaveBeenCalledWith("BHP");
  });
});
