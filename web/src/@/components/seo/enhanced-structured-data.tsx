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

  // Use provided dates or fallback to current date (rendered server-side, no hydration mismatch)
  const defaultDate = new Date().toISOString();

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
      "@type": "Place",
      name: "Australia",
      address: {
        "@type": "PostalAddress",
        addressCountry: "AU",
      },
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
  const logoUrl = `${siteConfig.url}/logo.png`;
  const schema = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: siteConfig.name,
    url: siteConfig.url,
    logo: {
      "@type": "ImageObject",
      url: logoUrl,
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
    // serviceType/offers/isBasedOn removed — not valid Organization properties
    // (Service/CreativeWork props respectively). ASIC provenance lives on the
    // Dataset schema where it belongs. GitHub sameAs removed: github.com/shorted
    // is not our account, and a wrong sameAs harms entity reconciliation.
    sameAs: [siteConfig.links.twitter],
    contactPoint: {
      "@type": "ContactPoint",
      email: siteConfig.contact.email,
      contactType: "customer service",
      areaServed: "AU",
      availableLanguage: "English",
    },
    // Note: aggregateRating removed - only add when real user reviews are collected
    // to comply with Google's structured data guidelines
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
  const logoUrl = `${siteConfig.url}/logo.png`;
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
        url: logoUrl,
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
