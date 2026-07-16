"use server";

import type {
  StockDetails,
  FinancialStatements as ProtoFinancialStatements,
  StatementValues,
  CompanyPerson as ProtoCompanyPerson,
  FinancialReport as ProtoFinancialReport,
  SocialMediaLinks as ProtoSocialMediaLinks,
  FinancialStatementsInfo as ProtoFinancialStatementsInfo,
} from "~/gen/stocks/v1alpha1/stocks_pb";
import type {
  EnrichedCompanyMetadata,
  FinancialReport,
  FinancialStatements,
  Person,
  SocialMediaLinks,
} from "~/@/types/company-metadata";
import { getStockDetails } from "./getStockDetails";
import { cache } from "react";

// This module previously issued its OWN GetStockDetails RPC under a second
// unstable_cache identity (['company-metadata', code]) — the same heavy
// payload was fetched and stored twice per cold render. It now reuses the
// getStockDetails action (edge-read + ['stock-details', code] cache) and
// only maps the result.
export const getEnrichedCompanyMetadata = cache(
  async (stockCode: string): Promise<EnrichedCompanyMetadata | null> => {
    try {
      const details = await getStockDetails(stockCode);
      if (!details?.productCode) {
        return null;
      }
      return mapStockDetailsToMetadata(details);
    } catch (error) {
      console.error("Error fetching enriched company metadata via API:", error);
      return null;
    }
  },
);

export async function hasEnrichedData(stockCode: string): Promise<boolean> {
  try {
    const details = await getStockDetails(stockCode.toUpperCase());
    return details?.enrichmentStatus === "completed";
  } catch (error) {
    console.error("Error checking enriched data:", error);
    return false;
  }
}

// getStockDetails serves TWO timestamp shapes: proto Timestamp objects
// ({seconds: bigint, nanos}) from the connect client, and RFC3339 STRINGS
// from the edge-read proto-JSON path. The old object-only math produced
// Number(undefined)*1000 = NaN for strings, and new Date(NaN).toISOString()
// throws RangeError — which the caller's catch turned into a silently
// missing enriched section on every edge-read render (and, under ISR,
// pinned that degraded HTML for the page TTL).
function toIsoDate(
  ts: StockDetails["enrichmentDate"] | string | undefined,
): string | null {
  if (!ts) return null;
  if (typeof ts === "string") {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof ts === "object" && "seconds" in ts) {
    const ms =
      Number(ts.seconds) * 1000 + Math.floor((ts.nanos ?? 0) / 1_000_000);
    return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
  }
  return null;
}

function mapStockDetailsToMetadata(
  details: StockDetails,
): EnrichedCompanyMetadata {
  const enrichmentDate = toIsoDate(details.enrichmentDate);

  return {
    stock_code: details.productCode,
    company_name: details.companyName ?? "",
    industry: details.industry ?? null,
    logo_url: null,
    logo_gcs_url: details.gcsUrl ?? null,
    website: details.website ?? null,
    description: details.summary ?? null,
    tags: details.tags ?? [],
    enhanced_summary: details.enhancedSummary ?? null,
    company_history: details.companyHistory ?? null,
    key_people: convertKeyPeople(details.keyPeople ?? []),
    financial_reports: convertFinancialReports(details.financialReports ?? []),
    competitive_advantages: details.competitiveAdvantages ?? null,
    risk_factors: details.riskFactors ?? [],
    recent_developments: details.recentDevelopments ?? null,
    social_media_links: convertSocialLinks(details.socialMediaLinks),
    financial_statements: convertFinancialStatements(
      details.productCode,
      details.financialStatements,
    ),
    enrichment_status: (details.enrichmentStatus ??
      "pending") as EnrichedCompanyMetadata["enrichment_status"],
    enrichment_date: enrichmentDate,
    enrichment_error: details.enrichmentError ?? null,
  };
}

function convertKeyPeople(people: ProtoCompanyPerson[]): Person[] {
  return people.map((person) => ({
    name: person.name ?? "",
    role: person.role ?? "",
    bio: person.bio ?? "",
    image_url: person.imageUrl || undefined,
    image_gcs_url: person.imageGcsUrl || undefined,
    linkedin_url: person.linkedinUrl || undefined,
    source_url: person.sourceUrl || undefined,
    source_type: person.sourceType || undefined,
  }));
}

function convertFinancialReports(
  reports: ProtoFinancialReport[],
): FinancialReport[] {
  return reports.map((report) => ({
    title: report.title ?? "",
    date: report.date ?? null,
    type: report.type ?? "",
    url: report.url ?? "",
    source: report.source ?? null,
    gcs_url: report.gcsUrl || null,
  }));
}

function convertSocialLinks(links?: ProtoSocialMediaLinks): SocialMediaLinks {
  return {
    linkedin: links?.linkedin ?? null,
    twitter: links?.twitter ?? null,
    facebook: links?.facebook ?? null,
    youtube: links?.youtube ?? null,
    website: links?.website ?? null,
  };
}

function convertFinancialStatements(
  stockCode: string,
  statements?: ProtoFinancialStatements,
): FinancialStatements | null {
  if (!statements) {
    return null;
  }

  const annual = {
    income_statement: convertStatementMap(statements.annual?.incomeStatement),
    balance_sheet: convertStatementMap(statements.annual?.balanceSheet),
    cash_flow: convertStatementMap(statements.annual?.cashFlow),
  };

  const quarterly = {
    income_statement: convertStatementMap(
      statements.quarterly?.incomeStatement,
    ),
    balance_sheet: convertStatementMap(statements.quarterly?.balanceSheet),
    cash_flow: convertStatementMap(statements.quarterly?.cashFlow),
  };

  const info = convertFinancialInfo(statements.info);
  const hasData =
    statements.success ||
    statements.error ||
    Object.values(annual).some(Boolean) ||
    Object.values(quarterly).some(Boolean) ||
    (info && Object.keys(info).length > 0);

  if (!hasData) {
    return null;
  }

  return {
    stock_code: stockCode,
    success: statements.success,
    annual,
    quarterly: Object.values(quarterly).some(Boolean) ? quarterly : undefined,
    info: info ?? {},
    error: statements.error ?? null,
  };
}

function convertStatementMap(
  group?: Record<string, StatementValues>,
): Record<string, Record<string, number | null>> | undefined {
  if (!group || Object.keys(group).length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(group).map(([period, metrics]) => [
      period,
      metrics?.metrics ?? {},
    ]),
  );
}

function convertFinancialInfo(
  info?: ProtoFinancialStatementsInfo,
): FinancialStatements["info"] | undefined {
  if (!info) {
    return undefined;
  }

  const result: FinancialStatements["info"] = {};
  let hasValue = false;

  const assign = <K extends keyof FinancialStatements["info"]>(
    key: K,
    value?: number | string,
  ) => {
    if (value === undefined || value === null) return;
    // Filter out zero values
    if (typeof value === "number" && value === 0) return;
    // Filter out string "0", "0000", etc.
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "" || /^0+\.?0*$/.test(trimmed)) return;
      const num = parseFloat(trimmed);
      if (isNaN(num) || num === 0) return;
    }
    result[key] = value as never;
    hasValue = true;
  };

  assign("market_cap", info.marketCap);
  assign("current_price", info.currentPrice);
  assign("pe_ratio", info.peRatio);
  assign("eps", info.eps);
  assign("dividend_yield", info.dividendYield);
  assign("beta", info.beta);
  assign("week_52_high", info.week52High);
  assign("week_52_low", info.week52Low);
  assign("volume", info.volume);
  assign(
    "employee_count",
    info.employeeCount ? Number(info.employeeCount) : undefined,
  );
  assign("sector", info.sector);
  assign("industry", info.industry);

  return hasValue ? result : undefined;
}
