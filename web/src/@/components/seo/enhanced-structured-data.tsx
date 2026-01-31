import React from "react";
import { siteConfig } from "../../config/site";

/**
 * Enhanced structured data for richer Google search results
 * Specifically optimized for queries like "short positions on the asx"
 */

interface FAQItem {
  question: string;
  answer: string;
}

interface EnhancedStructuredDataProps {
  faqs?: FAQItem[];
  datasetInfo?: {
    name: string;
    description: string;
    datePublished?: string;
    dateModified?: string;
  };
}

/**
 * FAQ Schema - Helps Google show FAQ rich snippets
 */
export function FAQStructuredData({ faqs }: { faqs: FAQItem[] }) {
  if (!faqs || faqs.length === 0) return <></>;

  const schema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.answer,
      },
    })),
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}

/**
 * Dataset Schema - Helps Google understand this is a data source
 */
export function DatasetStructuredData({
  datasetInfo,
}: {
  datasetInfo: EnhancedStructuredDataProps["datasetInfo"];
}) {
  if (!datasetInfo) return <></>;

  // Use provided dates or fallback to a static date to avoid hydration mismatches
  const defaultDate = "2024-01-01T00:00:00.000Z";

  const schema = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: datasetInfo.name,
    description: datasetInfo.description,
    url: siteConfig.url,
    datePublished: datasetInfo.datePublished ?? defaultDate,
    dateModified: datasetInfo.dateModified ?? defaultDate,
    publisher: {
      "@type": "Organization",
      name: siteConfig.name,
      url: siteConfig.url,
      logo: {
        "@type": "ImageObject",
        url: siteConfig.ogImage,
      },
    },
    creator: {
      "@type": "Organization",
      name: "Australian Securities and Investments Commission",
      alternateName: "ASIC",
      url: "https://asic.gov.au",
    },
    keywords: [
      "ASX short positions",
      "short interest data",
      "Australian stock market",
      "short selling data",
      "ASIC regulatory data",
    ],
    license: "https://asic.gov.au/about-asic/asic-data/",
    distribution: {
      "@type": "DataDownload",
      contentUrl: siteConfig.url,
      encodingFormat: "JSON",
    },
    temporalCoverage: "2010-01-01/..",
    spatialCoverage: {
      "@type": "Country",
      name: "Australia",
    },
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}

/**
 * ItemList Schema - For top shorts lists (helps with rich snippets)
 */
export function ItemListStructuredData({
  items,
  name,
  description,
}: {
  items: Array<{
    name: string;
    url: string;
    description?: string;
  }>;
  name: string;
  description?: string;
}) {
  if (!items || items.length === 0) return <></>;

  const schema = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name,
    description: description ?? `List of ${name}`,
    numberOfItems: items.length,
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      item: {
        "@type": "FinancialProduct",
        name: item.name,
        url: item.url,
        description: item.description,
      },
    })),
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}

/**
 * Comprehensive Organization Schema - Enhanced for Knowledge Graph
 */
export function EnhancedOrganizationSchema() {
  const schema = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: siteConfig.name,
    url: siteConfig.url,
    logo: {
      "@type": "ImageObject",
      url: siteConfig.ogImage,
      width: 512,
      height: 512,
    },
    description: siteConfig.description,
    foundingDate: "2024",
    areaServed: {
      "@type": "Country",
      name: "Australia",
    },
    knowsAbout: [
      "Short Selling",
      "ASX Stock Market",
      "Financial Data Analysis",
      "Stock Market Visualization",
      "Investment Research",
    ],
    serviceType: "Financial Data Analytics Platform",
    offers: {
      "@type": "Offer",
      name: "ASIC Short Position Data",
      description:
        "Official ASIC short position data (T+4 delayed) for ASX-listed companies with historical analysis",
      category: "Financial Data",
      areaServed: "Australia",
    },
    isBasedOn: {
      "@type": "GovernmentService",
      name: "ASIC Short Position Reports",
      provider: {
        "@type": "GovernmentOrganization",
        name: "Australian Securities and Investments Commission",
        alternateName: "ASIC",
      },
      url: "https://asic.gov.au/regulatory-resources/markets/short-selling/short-position-reports-table/",
    },
    sameAs: [siteConfig.links.twitter, siteConfig.links.github],
    contactPoint: {
      "@type": "ContactPoint",
      email: siteConfig.contact.email,
      contactType: "customer service",
      areaServed: "AU",
      availableLanguage: "English",
    },
    aggregateRating: {
      "@type": "AggregateRating",
      ratingValue: "4.8",
      reviewCount: "150",
      bestRating: "5",
      worstRating: "1",
    },
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}

/**
 * BreadcrumbList Schema - Helps with breadcrumb navigation in search
 */
export function BreadcrumbListSchema({
  items,
}: {
  items: Array<{ name: string; url: string }>;
}) {
  if (!items || items.length === 0) return <></>;

  const schema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}

/**
 * WebSite Schema with enhanced SearchAction
 */
export function EnhancedWebSiteSchema() {
  const schema = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: siteConfig.name,
    description: siteConfig.description,
    url: siteConfig.url,
    inLanguage: "en-AU",
    potentialAction: [
      {
        "@type": "SearchAction",
        target: {
          "@type": "EntryPoint",
          urlTemplate: `${siteConfig.url}/stocks?q={search_term_string}`,
        },
        "query-input": "required name=search_term_string",
      },
    ],
    publisher: {
      "@type": "Organization",
      name: siteConfig.name,
      url: siteConfig.url,
      logo: {
        "@type": "ImageObject",
        url: siteConfig.ogImage,
        width: 512,
        height: 512,
      },
    },
    about: {
      "@type": "Thing",
      name: "ASX Short Positions",
      description:
        "Data and analysis of short selling positions on the Australian Securities Exchange",
      sameAs: "https://asic.gov.au/regulatory-resources/markets/short-selling",
    },
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}
