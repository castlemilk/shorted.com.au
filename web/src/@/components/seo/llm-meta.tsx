/**
 * LLM-specific meta tags and structured data
 * Optimizes content for AI/LLM crawlers and indexing
 */

interface LLMMetaProps {
  title: string;
  description: string;
  keywords?: string[];
  content?: string;
  url?: string;
  dataSource?: string;
  dataFrequency?: string;
  lastUpdated?: string;
  requiresAuth?: boolean;
}

/**
 * Known data-source organisations, matched against the comma-separated names in
 * a non-ASIC `dataSource` prop. Government statistical agencies map to a
 * GovernmentOrganization + canonical domain; commercial portals to a plain
 * Organization + homepage. Anything unrecognised falls back to a bare-name
 * Organization (no unverifiable url/sameAs).
 */
const KNOWN_SOURCE_ORGS: ReadonlyArray<{
  match: RegExp;
  org: Record<string, unknown>;
}> = [
  {
    match: /\bABS\b|australian bureau of statistics/i,
    org: {
      "@type": "GovernmentOrganization",
      name: "Australian Bureau of Statistics",
      alternateName: "ABS",
      url: "https://abs.gov.au",
    },
  },
  {
    match: /\bRBA\b|reserve bank of australia/i,
    org: {
      "@type": "GovernmentOrganization",
      name: "Reserve Bank of Australia",
      alternateName: "RBA",
      url: "https://rba.gov.au",
    },
  },
  {
    match: /realestate\.com\.au/i,
    org: {
      "@type": "Organization",
      name: "realestate.com.au",
      url: "https://www.realestate.com.au",
    },
  },
  {
    match: /domain\.com\.au/i,
    org: {
      "@type": "Organization",
      name: "domain.com.au",
      url: "https://www.domain.com.au",
    },
  },
];

/**
 * Derive schema.org sourceOrganization entries from a human-authored dataSource
 * string (e.g. "ABS, RBA" or "realestate.com.au, domain.com.au") — one
 * de-duplicated entry per comma-separated name — so provenance matches the
 * surface's real origin instead of a hardcoded regulator.
 */
function buildSourceOrganizations(
  dataSource: string,
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const orgs: Record<string, unknown>[] = [];
  for (const raw of dataSource.split(",")) {
    const name = raw.trim();
    if (!name) continue;
    const known = KNOWN_SOURCE_ORGS.find((entry) => entry.match.test(name));
    const org = known?.org ?? { "@type": "Organization", name };
    const key = JSON.stringify(org);
    if (seen.has(key)) continue;
    seen.add(key);
    orgs.push(org);
  }
  // A whitespace-only dataSource would yield no entries; emit a single
  // bare-name Organization so provenance is never empty.
  if (orgs.length === 0) {
    orgs.push({
      "@type": "Organization",
      name: dataSource.trim() || "Shorted",
    });
  }
  return orgs;
}

export function LLMMeta({
  title,
  description,
  keywords = [],
  content,
  url,
  dataSource = "ASIC",
  dataFrequency = "daily",
  lastUpdated,
  requiresAuth = false,
}: LLMMetaProps) {
  // Provenance is derived from `dataSource` so non-ASIC surfaces (housing,
  // economy, news) don't emit false ASIC/regulatory structured data. The
  // default surface — plus any dataSource that names ASIC — keeps its original
  // regulatory provenance byte-for-byte.
  const isAsicSource = dataSource.toUpperCase().includes("ASIC");

  // Data provenance for LLMs: a single ASIC GovernmentOrganization for
  // ASIC-sourced data, otherwise one entry per comma-separated source name.
  const sourceOrganization = isAsicSource
    ? {
        "@type": "GovernmentOrganization",
        name: "Australian Securities and Investments Commission",
        alternateName: "ASIC",
        url: "https://asic.gov.au",
      }
    : buildSourceOrganizations(dataSource);

  // Domain-specific context (Thing, not FinancialProduct — short-position data
  // isn't an offered financial product in the schema.org sense). Only the ASIC
  // short-position surfaces can substantiate this subject, so other sources
  // omit `about` rather than assert a false short-selling claim.
  const about = isAsicSource
    ? [
        {
          "@type": "Thing",
          name: "ASX Securities Short Positions",
          description:
            "Short selling data for Australian Securities Exchange listed companies",
          sameAs:
            "https://asic.gov.au/regulatory-resources/markets/short-selling/",
        },
      ]
    : undefined;

  // Data quality indicators. The regulatory-accuracy guarantee only holds for
  // ASIC-mandated filings, so it's omitted for other sources.
  const additionalProperty = [
    {
      "@type": "PropertyValue",
      name: "dataSource",
      value: dataSource,
    },
    {
      "@type": "PropertyValue",
      name: "updateFrequency",
      value: dataFrequency,
    },
    ...(isAsicSource
      ? [
          {
            "@type": "PropertyValue",
            name: "dataAccuracy",
            value: "regulatory",
          },
        ]
      : []),
    {
      "@type": "PropertyValue",
      name: "contentType",
      value: "financial-data",
    },
  ];

  const llmStructuredData = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    description: description,
    keywords: keywords.join(", "),

    // Data provenance for LLMs
    sourceOrganization,

    // Content characteristics
    inLanguage: "en-AU",
    audience: {
      "@type": "Audience",
      audienceType: ["Investors", "Financial Analysts", "Researchers"],
    },

    // Temporal information
    datePublished: lastUpdated,
    dateModified: lastUpdated,

    // Usage rights
    license: "https://shorted.com.au/terms",
    isAccessibleForFree: !requiresAuth,

    // Domain-specific context (see `about` above) — only present for ASIC
    // short-position surfaces.
    ...(about ? { about } : {}),

    // Data quality indicators
    additionalProperty,
  };

  return (
    <>
      {/* Note: description and keywords meta tags are handled by Next.js generateMetadata.
          Do NOT add <meta name="description"> here — it creates duplicates. */}

      {/* LLM-specific meta tags */}
      <meta name="ai:content-type" content="financial-data" />
      <meta name="ai:data-source" content={dataSource} />
      <meta name="ai:update-frequency" content={dataFrequency} />
      <meta name="ai:language" content="en-AU" />
      <meta name="ai:domain" content="finance" />
      {/* The short-selling subdomain + regulatory/T+4/ASIC-authority tags are
          true ONLY for the ASIC short-position surfaces — on other data sources
          (housing, economy, portal listings) they'd be the same false
          provenance the JSON-LD branch above fixes, so they're gated the same
          way. Non-ASIC pages get the truthful authority (the dataSource). */}
      {isAsicSource ? <meta name="ai:subdomain" content="short-selling" /> : null}

      {/* Content classification */}
      <meta name="content-type" content="factual" />
      <meta name="content-category" content="financial-market-data" />
      <meta name="geographic-coverage" content="Australia" />

      {/* Data quality indicators */}
      {isAsicSource ? (
        <>
          <meta name="data-accuracy" content="regulatory" />
          <meta name="data-lag" content="T+4 trading days" />
          <meta name="data-source-authority" content="ASIC - Australian Securities and Investments Commission" />
        </>
      ) : (
        <meta name="data-source-authority" content={dataSource} />
      )}

      {/* Usage guidelines */}
      <meta name="usage-rights" content="informational" />
      <meta name="disclaimer" content="not-financial-advice" />
      <meta
        name="access-control"
        content={requiresAuth ? "authenticated" : "public"}
      />

      {/* Links to documentation */}
      <link rel="documentation" href="/docs/llm-context" />
      <link rel="api-documentation" href="/docs/api-reference" />
      <link rel="alternate" type="text/markdown" href="/docs/llm-context" />

      {/* Structured data for LLMs */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(llmStructuredData),
        }}
      />

    </>
  );
}

/**
 * Enhanced meta tags for stock-specific pages
 */
interface StockLLMMetaProps {
  stockCode: string;
  companyName: string;
  industry: string;
  sector: string;
  currentShortPosition?: number;
  shortPercentage?: number;
  lastUpdated?: string;
}

export function StockLLMMeta({
  stockCode,
  companyName,
  industry,
  sector,
  currentShortPosition,
  shortPercentage,
  lastUpdated,
}: StockLLMMetaProps) {
  // No FinancialProduct JSON-LD here: listed equities aren't offered
  // financial products (schema.org sense), the type has no rich result, and
  // it duplicated the stock page's Corporation block with invalid props
  // (exchange/industry/sector aren't Corporation properties). The current
  // short-position values live on the page's Dataset schema instead.
  void companyName;
  void currentShortPosition;
  void lastUpdated;

  return (
    <>
      {/* Stock-specific meta tags */}
      <meta name="stock:ticker" content={stockCode} />
      <meta name="stock:exchange" content="ASX" />
      <meta name="stock:industry" content={industry} />
      <meta name="stock:sector" content={sector} />
      {shortPercentage && (
        <meta
          name="stock:short-interest"
          content={shortPercentage.toString()}
        />
      )}

      {/* LLM context */}
      <meta name="ai:entity-type" content="stock" />
      <meta name="ai:entity-id" content={stockCode} />
    </>
  );
}
