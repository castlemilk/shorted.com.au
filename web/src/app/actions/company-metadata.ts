"use server";

import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
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
import { SHORTS_API_URL } from "./config";

const transport = createConnectTransport({
  baseUrl: SHORTS_API_URL,
});

const client = createClient(ShortedStocksService, transport);

export async function getEnrichedCompanyMetadata(
  stockCode: string,
): Promise<EnrichedCompanyMetadata | null> {
  try {
    const response = await client.getStockDetails({
      productCode: stockCode.toUpperCase(),
    });
    const details = response;

    if (!details.productCode) {
      return null;
    }

    return mapStockDetailsToMetadata(details);
  } catch (error) {
    console.error("Error fetching enriched company metadata via API:", error);
    return null;
  }
}

export async function hasEnrichedData(stockCode: string): Promise<boolean> {
  try {
    const response = await client.getStockDetails({
      productCode: stockCode.toUpperCase(),
    });
    const details = response;
    return details.enrichmentStatus === "completed";
  } catch (error) {
    console.error("Error checking enriched data:", error);
    return false;
  }
}

function mapStockDetailsToMetadata(
  details: StockDetails,
): EnrichedCompanyMetadata {
  const enrichmentDate = details.enrichmentDate
    ? new Date(
        Number(details.enrichmentDate.seconds) * 1000 +
          details.enrichmentDate.nanos / 1_000_000,
      ).toISOString()
    : null;

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

function convertKeyPeople(
  people: ProtoCompanyPerson[],
): Person[] {
  return people.map((person) => ({
    name: person.name ?? "",
    role: person.role ?? "",
    bio: person.bio ?? "",
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
    gcs_url: report.gcsUrl ?? null,
  }));
}

function convertSocialLinks(
  links?: ProtoSocialMediaLinks,
): SocialMediaLinks {
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
  assign("employee_count", info.employeeCount ? Number(info.employeeCount) : undefined);
  assign("sector", info.sector);
  assign("industry", info.industry);

  return hasValue ? result : undefined;
}
