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
  const llmStructuredData = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    description: description,
    keywords: keywords.join(", "),

    // Data provenance for LLMs
    sourceOrganization: {
      "@type": "GovernmentOrganization",
      name: "Australian Securities and Investments Commission",
      alternateName: "ASIC",
      url: "https://asic.gov.au",
    },

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

    // Domain-specific context (Thing, not FinancialProduct — short-position
    // data isn't an offered financial product in the schema.org sense)
    about: [
      {
        "@type": "Thing",
        name: "ASX Securities Short Positions",
        description:
          "Short selling data for Australian Securities Exchange listed companies",
        sameAs:
          "https://asic.gov.au/regulatory-resources/markets/short-selling/",
      },
    ],

    // Data quality indicators
    additionalProperty: [
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
      {
        "@type": "PropertyValue",
        name: "dataAccuracy",
        value: "regulatory",
      },
      {
        "@type": "PropertyValue",
        name: "contentType",
        value: "financial-data",
      },
    ],
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
      <meta name="ai:subdomain" content="short-selling" />

      {/* Content classification */}
      <meta name="content-type" content="factual" />
      <meta name="content-category" content="financial-market-data" />
      <meta name="geographic-coverage" content="Australia" />

      {/* Data quality indicators */}
      <meta name="data-accuracy" content="regulatory" />
      <meta name="data-lag" content="T+4 trading days" />
      <meta name="data-source-authority" content="ASIC - Australian Securities and Investments Commission" />

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
