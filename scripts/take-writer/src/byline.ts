// Desk bylines — map a company's industry string to a Shorted desk beat.
// Kept in its own tiny module so tests can import it without pulling
// newsroom.ts's heavy transitive deps (OpenAI, GCS, pg).

const BEATS: Array<[RegExp, string]> = [
  [/mining|materials|metals|gold|lithium|uranium/i, "Mining & Resources"],
  [/energy|oil|gas|utilities/i, "Energy"],
  [/bank|financial|insurance|capital/i, "Banks & Finance"],
  [/health|pharma|biotech|medical/i, "Health & Biotech"],
  [/tech|software|semiconductor|internet|media/i, "Technology & Media"],
  [/retail|consumer|food|beverage/i, "Consumer & Retail"],
  [/real estate|reit|property/i, "Property"],
];

export function deskByline(industry: string | null | undefined): string {
  const beat = BEATS.find(([re]) => re.test(industry ?? ""))?.[1] ?? "Markets";
  return `The Shorted Desk — ${beat}`;
}
