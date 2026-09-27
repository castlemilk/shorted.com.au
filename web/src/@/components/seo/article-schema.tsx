import { siteConfig } from "~/@/config/site";

interface ArticleSchemaProps {
  /** Schema.org type. BlogPosting for `/blog`, NewsArticle for the newsroom. */
  type?: "Article" | "BlogPosting" | "NewsArticle";
  title: string;
  description: string;
  datePublished: string;
  dateModified?: string;
  authorName: string;
  /** Author profile slug under /authors/ — defaults to slugified authorName. */
  authorSlug?: string;
  authorImage?: string;
  image?: string;
  url: string;
  keywords?: string[];
  /** Section / category label; defaults to "Finance". */
  articleSection?: string;
}

// Google's Article rich-result requirements expect fully-qualified image URLs;
// relative paths can be dropped when the JSON-LD is consumed out of page context.
const absoluteUrl = (u?: string): string | undefined =>
  u && u.startsWith("/") ? `https://shorted.com.au${u}` : u;

export function ArticleSchema({
  type = "Article",
  title,
  description,
  datePublished,
  dateModified,
  authorName,
  authorSlug,
  authorImage,
  image,
  url,
  keywords = [],
  articleSection = "Finance",
}: ArticleSchemaProps) {
  const schema = {
    "@context": "https://schema.org",
    "@type": type,
    headline: title,
    description: description,
    image: image ? [absoluteUrl(image)] : [],
    datePublished: datePublished,
    dateModified: dateModified ?? datePublished,
    author: {
      "@type": "Person",
      name: authorName,
      image: absoluteUrl(authorImage),
      // The author route is /authors/[slug] (plural).
      url: `https://shorted.com.au/authors/${authorSlug ?? authorName.toLowerCase().replace(/\s+/g, "-")}`,
    },
    publisher: {
      "@type": "Organization",
      name: "Shorted",
      url: "https://shorted.com.au",
      logo: {
        "@type": "ImageObject",
        url: siteConfig.logo.url,
        width: siteConfig.logo.width,
        height: siteConfig.logo.height,
      },
    },
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": url,
    },
    keywords: keywords.join(", "),
    articleSection,
    inLanguage: "en-AU",
    isAccessibleForFree: true,
    speakable: {
      "@type": "SpeakableSpecification",
      cssSelector: ["h1", "[role='article'] p:first-of-type", ".article-summary"],
    },
    about: [
      {
        "@type": "Thing",
        name: "Short Selling",
        sameAs: "https://en.wikipedia.org/wiki/Short_(finance)",
      },
      {
        "@type": "Thing", 
        name: "Australian Securities Exchange",
        sameAs: "https://en.wikipedia.org/wiki/Australian_Securities_Exchange",
      },
      {
        "@type": "Thing",
        name: "ASIC",
        sameAs: "https://asic.gov.au",
      }
    ],
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}
