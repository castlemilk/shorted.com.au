import type { Metadata } from "next";

import { siteConfig } from "~/@/config/site";
import type { ParsedEndpoint } from "~/lib/openapi/types";

/**
 * Metadata for one page of the /docs/api cluster.
 *
 * Every page here names its own canonical and social card. Without them the
 * index served the homepage's title and description, and the endpoint pages
 * and client guides had no canonical and shared the homepage's og:url (SEO
 * review 2026-10-21, F07). Titles carry no brand: the root template appends
 * " | Shorted" once.
 */
export function apiDocsMetadata({
  title,
  description,
  canonical,
}: {
  title: string;
  description: string;
  canonical: string;
}): Metadata {
  return {
    title,
    description,
    alternates: { canonical },
    // A page that sets openGraph replaces the root's, so it names the card.
    openGraph: {
      type: "website",
      url: canonical,
      title,
      description,
      siteName: siteConfig.name,
      locale: "en_AU",
      images: [
        {
          url: siteConfig.ogImage,
          width: 1200,
          height: 630,
          alt: `${title} — ${siteConfig.name}`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [siteConfig.ogImage],
      site: siteConfig.twitterHandle,
      creator: siteConfig.twitterHandle,
    },
  };
}

// "/shorts.v1alpha1.OwnershipService/GetInstitution": the service, the method.
const CONNECT_PATH = /^\/[a-z0-9_.]+\.([A-Za-z]+)Service\/([A-Za-z]+)$/;

/**
 * "GetInstitution — Ownership API" for a Connect method, the summary for a
 * plain HTTP endpoint. A method's summary in the spec is usually its bare
 * name, and a few are 100 to 190 character sentences, so the summary alone
 * makes a poor title.
 */
export function endpointTitle(
  endpoint: Pick<ParsedEndpoint, "method" | "path" | "summary">,
): string {
  const connect = CONNECT_PATH.exec(endpoint.path);
  if (connect) {
    const service = connect[1]!.replace(/([a-z])([A-Z])/g, "$1 $2");
    return `${connect[2]} — ${service} API`;
  }
  const summary = endpoint.summary?.trim();
  return summary ? summary : `${endpoint.method} ${endpoint.path}`;
}

/**
 * A spec description as a meta description: proto comments wrap with a
 * newline and a space, and a few run past 1,000 characters.
 */
export function descriptionSnippet(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const wordEnd = cut.lastIndexOf(" ");
  const clipped = wordEnd > max / 2 ? cut.slice(0, wordEnd) : cut;
  return `${clipped.replace(/[\s,;:.]+$/, "")}…`;
}
