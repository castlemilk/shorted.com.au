/**
 * LLM-specific meta tags and structured data
 * Optimizes content for AI/LLM crawlers and indexing
 */

interface LLMMetaProps {
  title: string;
  description: string;
  keywords?: string[];
  content?: string;
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

    // Domain-specific context
    about: [
      {
        "@type": "FinancialProduct",
        name: "ASX Securities Short Positions",
        description:
          "Short selling data for Australian Securities Exchange listed companies",
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
      {/* Standard meta tags enhanced for LLMs */}
      <meta name="description" content={description} />
      {keywords.length > 0 && (
        <meta name="keywords" content={keywords.join(", ")} />
      )}

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
      <meta name="data-lag" content="1-2 business days" />

      {/* Usage guidelines */}
      <meta name="usage-rights" content="informational" />
      <meta name="disclaimer" content="not-financial-advice" />
      <meta
        name="access-control"
        content={requiresAuth ? "authenticated" : "public"}
      />
      <meta
        name="robots"
        content={requiresAuth ? "noindex" : "index, follow"}
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

      {/* Dataset structured data if content is provided */}
      {content && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "Dataset",
              name: title,
              description: description,
              url: typeof window !== "undefined" ? window.location.href : "",
              keywords: keywords.join(", "),
              license: "https://shorted.com.au/terms",
              creator: {
                "@type": "Organization",
                name: "Shorted",
                url: "https://shorted.com.au",
              },
              provider: {
                "@type": "GovernmentOrganization",
                name: "ASIC",
                url: "https://asic.gov.au",
              },
              temporalCoverage: "2010/..",
              spatialCoverage: {
                "@type": "Place",
                name: "Australia",
              },
              distribution: {
                "@type": "DataDownload",
                encodingFormat: "application/json",
                contentUrl: "/api",
              },
            }),
          }}
        />
      )}
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
  const stockData = {
    "@context": "https://schema.org",
    "@type": "FinancialProduct",
    name: `${companyName} (${stockCode})`,
    description: `Short position analysis for ${companyName} on the ASX`,
    url: `https://shorted.com.au/shorts/${stockCode}`,

    // Stock identification
    identifier: {
      "@type": "PropertyValue",
      propertyID: "Ticker Symbol",
      value: stockCode,
    },

    // Company details
    about: {
      "@type": "Corporation",
      name: companyName,
      tickerSymbol: stockCode,
      exchange: "ASX",
      industry: industry,
      sector: sector,
    },

    // Current metrics
    ...(currentShortPosition && {
      additionalProperty: [
        {
          "@type": "PropertyValue",
          name: "currentShortPosition",
          value: currentShortPosition,
          unitText: "shares",
        },
        {
          "@type": "PropertyValue",
          name: "shortPercentage",
          value: shortPercentage,
          unitText: "percent",
        },
      ],
    }),

    // Temporal
    dateModified: lastUpdated,
  };

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

      {/* Structured data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(stockData),
        }}
      />
    </>
  );
}
