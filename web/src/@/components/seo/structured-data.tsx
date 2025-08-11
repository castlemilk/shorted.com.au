import { siteConfig } from "../../config/site";

interface StructuredDataProps {
  type?: "WebSite" | "Organization" | "Article" | "FinancialService";
  data?: Record<string, unknown>;
}

export function StructuredData({
  type = "WebSite",
  data = {},
}: StructuredDataProps) {
  const getStructuredData = () => {
    const baseData = {
      "@context": "https://schema.org",
    };

    switch (type) {
      case "WebSite":
        return {
          ...baseData,
          "@type": "WebSite",
          name: siteConfig.name,
          description: siteConfig.description,
          url: siteConfig.url,
          potentialAction: {
            "@type": "SearchAction",
            target: {
              "@type": "EntryPoint",
              urlTemplate: `${siteConfig.url}/shorts/{search_term_string}`,
            },
            "query-input": "required name=search_term_string",
          },
          publisher: {
            "@type": "Organization",
            name: siteConfig.name,
            url: siteConfig.url,
            logo: {
              "@type": "ImageObject",
              url: siteConfig.ogImage,
            },
          },
          ...data,
        };

      case "Organization":
        return {
          ...baseData,
          "@type": "Organization",
          name: siteConfig.name,
          description: siteConfig.description,
          url: siteConfig.url,
          logo: {
            "@type": "ImageObject",
            url: siteConfig.ogImage,
          },
          sameAs: [siteConfig.links.twitter, siteConfig.links.github],
          contactPoint: {
            "@type": "ContactPoint",
            email: siteConfig.contact.email,
            contactType: "customer service",
          },
          ...data,
        };

      case "FinancialService":
        return {
          ...baseData,
          "@type": "FinancialService",
          name: siteConfig.name,
          description: siteConfig.description,
          url: siteConfig.url,
          serviceType: "Financial Data Analytics",
          areaServed: {
            "@type": "Country",
            name: "Australia",
          },
          provider: {
            "@type": "Organization",
            name: siteConfig.name,
            url: siteConfig.url,
          },
          ...data,
        };

      case "Article":
        return {
          ...baseData,
          "@type": "Article",
          publisher: {
            "@type": "Organization",
            name: siteConfig.name,
            url: siteConfig.url,
            logo: {
              "@type": "ImageObject",
              url: siteConfig.ogImage,
            },
          },
          ...data,
        };

      default:
        return { ...baseData, ...data };
    }
  };

  const structuredData = getStructuredData();

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(structuredData),
      }}
    />
  );
}

// Specific structured data for stock pages
interface StockStructuredDataProps {
  stockCode: string;
  companyName?: string;
  description?: string;
}

export function StockStructuredData({
  stockCode,
  companyName = stockCode,
  description,
}: StockStructuredDataProps) {
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "FinancialProduct",
    name: `${stockCode} Short Position Analysis`,
    description:
      description ?? `Analysis of ${stockCode} short positions on the ASX`,
    url: `${siteConfig.url}/shorts/${stockCode}`,
    provider: {
      "@type": "Organization",
      name: siteConfig.name,
      url: siteConfig.url,
    },
    about: {
      "@type": "Corporation",
      name: companyName,
      tickerSymbol: stockCode,
      exchange: "ASX",
    },
    category: "Stock Market Analysis",
    aggregateRating: {
      "@type": "AggregateRating",
      ratingValue: "4.5",
      reviewCount: "100",
      bestRating: "5",
      worstRating: "1",
    },
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(structuredData),
      }}
    />
  );
}
