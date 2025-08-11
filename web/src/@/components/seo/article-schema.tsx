interface ArticleSchemaProps {
  title: string;
  description: string;
  datePublished: string;
  dateModified?: string;
  authorName: string;
  authorImage?: string;
  image?: string;
  url: string;
  keywords?: string[];
}

export function ArticleSchema({
  title,
  description,
  datePublished,
  dateModified,
  authorName,
  authorImage,
  image,
  url,
  keywords = [],
}: ArticleSchemaProps) {
  const schema = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: title,
    description: description,
    image: image ? [image] : [],
    datePublished: datePublished,
    dateModified: dateModified ?? datePublished,
    author: {
      "@type": "Person",
      name: authorName,
      image: authorImage,
      url: `https://shorted.com.au/author/${authorName.toLowerCase().replace(/\s+/g, '-')}`,
    },
    publisher: {
      "@type": "Organization",
      name: "Shorted",
      url: "https://shorted.com.au",
      logo: {
        "@type": "ImageObject",
        url: "https://shorted.com.au/logo.png",
        width: 512,
        height: 512,
      },
    },
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": url,
    },
    keywords: keywords.join(", "),
    articleSection: "Finance",
    inLanguage: "en-AU",
    isAccessibleForFree: true,
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