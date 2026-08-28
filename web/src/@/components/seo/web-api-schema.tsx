/**
 * schema.org WebAPI markup for the public API docs.
 *
 * Search engines and LLM crawlers use this to recognise /docs/api as an API
 * surface rather than an ordinary article, and to pick up the machine-readable
 * entry points (the markdown twin, the terms, the licence).
 */
export function WebApiSchema() {
  const schema = {
    "@context": "https://schema.org",
    "@type": "WebAPI",
    name: "Shorted Public API",
    description:
      "Programmatic access to ASIC short position data for ASX-listed securities, Australian house prices and suburb metrics, ABS/RBA economic series, and the federal register of members' and senators' interests.",
    url: "https://shorted.com.au/docs/api",
    documentation: "https://shorted.com.au/docs/api.md",
    provider: {
      "@type": "Organization",
      name: "Shorted",
      url: "https://shorted.com.au",
    },
    termsOfService: "https://shorted.com.au/terms",
    license: "https://creativecommons.org/licenses/by/4.0/",
    potentialAction: {
      "@type": "ConsumeAction",
      target: "https://api.shorted.com.au",
    },
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}
