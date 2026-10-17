import { siteConfig } from "~/@/config/site";
import { STATE_NAMES } from "@/lib/housing/states";

/**
 * JSON-LD for a suburb profile: a `Place` with real coordinates and the
 * facts the page states, a `Dataset` for the Valuer-General price series when
 * the suburb has one, and the breadcrumb trail the context bar implies.
 *
 * The coordinates come from the same projected boundary the page's locator
 * inset renders (lib/housing/suburb-geometry), not a geocoder — so a suburb
 * with no committed boundary simply gets no `geo` block rather than a guess.
 * Nothing here is stated that the page does not also render: an unpriced
 * suburb emits no Dataset and no price property.
 */
export interface SuburbStructuredDataProps {
  name: string;
  url: string;
  stateCode: string;
  centroid?: { lat: number; lon: number } | null;
  lgaName?: string | null;
  population?: number | null;
  medianAge?: number | null;
  medianWeeklyHhdIncome?: number | null;
  latestMedianPrice?: number | null;
  /** ISO date of the latest Valuer-General period, when priced. */
  latestPeriodIso?: string | null;
  yoyPct?: number | null;
  censusYear?: number | null;
}

export function buildSuburbJsonLd(p: SuburbStructuredDataProps): unknown[] {
  const stateName = STATE_NAMES[p.stateCode] ?? p.stateCode;
  const priced = (p.latestMedianPrice ?? 0) > 0;

  const additionalProperty: unknown[] = [];
  if (priced) {
    additionalProperty.push({
      "@type": "PropertyValue",
      name: "Median house price",
      value: Math.round(p.latestMedianPrice!),
      unitCode: "AUD",
      ...(p.latestPeriodIso ? { validFrom: p.latestPeriodIso } : {}),
    });
    if ((p.yoyPct ?? 0) !== 0) {
      additionalProperty.push({
        "@type": "PropertyValue",
        name: "Median house price change, 12 months",
        value: Number((p.yoyPct!).toFixed(1)),
        unitText: "%",
      });
    }
  }
  if ((p.population ?? 0) > 0) {
    additionalProperty.push({
      "@type": "PropertyValue",
      name: `Population (ABS Census ${p.censusYear ?? 2021})`,
      value: p.population,
    });
  }
  if ((p.medianAge ?? 0) > 0) {
    additionalProperty.push({ "@type": "PropertyValue", name: "Median age", value: p.medianAge });
  }
  if ((p.medianWeeklyHhdIncome ?? 0) > 0) {
    additionalProperty.push({
      "@type": "PropertyValue",
      name: "Median weekly household income",
      value: Math.round(p.medianWeeklyHhdIncome!),
      unitCode: "AUD",
    });
  }

  const containedInPlace: unknown[] = [];
  if (p.lgaName) containedInPlace.push({ "@type": "AdministrativeArea", name: p.lgaName });
  containedInPlace.push({ "@type": "State", name: stateName });
  containedInPlace.push({ "@type": "Country", name: "Australia" });

  const place = {
    "@context": "https://schema.org",
    "@type": "Place",
    "@id": `${p.url}#place`,
    name: p.name,
    url: p.url,
    address: { "@type": "PostalAddress", addressLocality: p.name, addressRegion: p.stateCode, addressCountry: "AU" },
    ...(p.centroid
      ? {
          geo: {
            "@type": "GeoCoordinates",
            latitude: Number(p.centroid.lat.toFixed(5)),
            longitude: Number(p.centroid.lon.toFixed(5)),
          },
        }
      : {}),
    containedInPlace,
    ...(additionalProperty.length ? { additionalProperty } : {}),
  };

  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: siteConfig.url },
      { "@type": "ListItem", position: 2, name: "House prices", item: `${siteConfig.url}/housing` },
      { "@type": "ListItem", position: 3, name: stateName, item: `${siteConfig.url}/housing/${p.stateCode.toLowerCase()}` },
      { "@type": "ListItem", position: 4, name: p.name, item: p.url },
    ],
  };

  const graph: unknown[] = [place, breadcrumb];
  if (priced) {
    graph.push({
      "@context": "https://schema.org",
      "@type": "Dataset",
      name: `${p.name} median house prices`,
      description: `Rolling median of settled house transfers in ${p.name}, ${stateName}, from ${stateName} Valuer-General open data, with ABS Census demographics.`,
      url: p.url,
      isAccessibleForFree: true,
      license: "https://creativecommons.org/licenses/by/4.0/",
      creator: { "@type": "Organization", name: siteConfig.name, url: siteConfig.url },
      sourceOrganization: [
        { "@type": "GovernmentOrganization", name: `${stateName} Valuer-General` },
        { "@type": "GovernmentOrganization", name: "Australian Bureau of Statistics", url: "https://abs.gov.au" },
      ],
      spatialCoverage: { "@id": `${p.url}#place` },
      ...(p.latestPeriodIso ? { temporalCoverage: `../${p.latestPeriodIso}` } : {}),
      variableMeasured: "Median house price (AUD)",
    });
  }
  return graph;
}

export function SuburbStructuredData(props: SuburbStructuredDataProps) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(buildSuburbJsonLd(props)) }}
    />
  );
}
