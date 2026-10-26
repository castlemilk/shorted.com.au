import React from "react";
import { siteConfig } from "../../config/site";
import { JsonLd } from "~/@/components/seo/json-ld";

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
    /**
     * Canonical URL of the page this Dataset describes. Defaults to the site
     * root — pass the page's own URL, otherwise every Dataset on the site
     * claims to live at the homepage and they collapse into one entity.
     */
    url?: string;
    datePublished?: string;
    /**
     * The date the data runs to (the latest ASIC report it carries). Omitted
     * from the JSON-LD when absent: the render time is not a data date.
     */
    dateModified?: string;
  };
}

/**
 * Fixed publication date for the ASIC short-position dataset surfaces.
 *
 * Was `new Date()`, which made datePublished drift forward every regeneration
 * and land AFTER dateModified (the real data date) — an incoherent pair that
 * Google reads as "modified before it existed". A dataset's publication date
 * is a constant; only dateModified moves.
 */
const DATASET_PUBLISHED_ISO = "2024-01-01T00:00:00.000Z";

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
    <JsonLd data={schema} />
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

  const pageUrl = datasetInfo.url ?? siteConfig.url;
  const datePublished = datasetInfo.datePublished ?? DATASET_PUBLISHED_ISO;
  // dateModified is the data date, and only the caller knows it. It used to
  // fall back to `new Date()`, which told Google the homepage's data was
  // modified at render time (2026-10-21T00:34:49Z against data that ran to
  // 2026-10-15). Without a date (undefined or "") the field is left out.
  const dateModified = datasetInfo.dateModified;

  const schema = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: datasetInfo.name,
    description: datasetInfo.description,
    url: pageUrl,
    // Never let datePublished follow dateModified.
    datePublished:
      dateModified && new Date(dateModified) < new Date(datePublished)
        ? dateModified
        : datePublished,
    ...(dateModified ? { dateModified } : {}),
    publisher: {
      "@type": "Organization",
      name: siteConfig.name,
      url: siteConfig.url,
      logo: {
        "@type": "ImageObject",
        url: siteConfig.logo.url,
        width: siteConfig.logo.width,
        height: siteConfig.logo.height,
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
      contentUrl: pageUrl,
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
    <JsonLd data={schema} />
  );
}

/** ItemList schema for ordered collections (helps with rich snippets). */
export function ItemListStructuredData({
  items,
  name,
  description,
  itemType = "FinancialProduct",
}: {
  items: Array<{
    name: string;
    url: string;
    description?: string;
    /** Article-family extras (BlogPosting): a listed article with only
     *  name/url reads as a partial Article to validators. Absolute URLs. */
    headline?: string;
    image?: string;
    datePublished?: string;
    dateModified?: string;
    author?: { name: string; url?: string };
  }>;
  name: string;
  description?: string;
  /** Schema.org type for each listed entity; stock lists retain the default. */
  itemType?: "FinancialProduct" | "Place" | "WebPage" | "BlogPosting";
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
        "@type": itemType,
        name: item.name,
        url: item.url,
        description: item.description,
        ...(item.headline ? { headline: item.headline } : {}),
        ...(item.image ? { image: item.image } : {}),
        ...(item.datePublished ? { datePublished: item.datePublished } : {}),
        ...(item.dateModified ? { dateModified: item.dateModified } : {}),
        ...(item.author
          ? { author: { "@type": "Person", ...item.author } }
          : {}),
      },
    })),
  };

  return (
    <JsonLd data={schema} />
  );
}

/**
 * Comprehensive Organization Schema - Enhanced for Knowledge Graph
 */
export function EnhancedOrganizationSchema() {
  const logoUrl = siteConfig.logo.url;
  const schema = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: siteConfig.name,
    url: siteConfig.url,
    logo: {
      "@type": "ImageObject",
      url: logoUrl,
      width: siteConfig.logo.width,
      height: siteConfig.logo.height,
    },
    description: siteConfig.description,
    foundingDate: siteConfig.company.foundingDate,
    foundingLocation: {
      "@type": "Place",
      name: `${siteConfig.company.city}, ${siteConfig.company.countryName}`,
    },
    address: {
      "@type": "PostalAddress",
      addressLocality: siteConfig.company.city,
      addressRegion: siteConfig.company.region,
      addressCountry: siteConfig.company.country,
    },
    founder: {
      "@type": "Person",
      name: siteConfig.founder.name,
      jobTitle: siteConfig.founder.jobTitle,
      url: `${siteConfig.url}${siteConfig.founder.profilePath}`,
      image: siteConfig.founder.image,
      sameAs: [
        siteConfig.founder.website,
        siteConfig.founder.linkedin,
        siteConfig.founder.github,
      ],
    },
    // The data covers ASX stocks, but the product is a web/API service
    // available worldwide.
    areaServed: "Worldwide",
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
    <JsonLd data={schema} />
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
    <JsonLd data={schema} />
  );
}

/**
 * WebSite Schema with enhanced SearchAction
 */
export function EnhancedWebSiteSchema() {
  const logoUrl = siteConfig.logo.url;
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
        width: siteConfig.logo.width,
        height: siteConfig.logo.height,
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
    <JsonLd data={schema} />
  );
}
