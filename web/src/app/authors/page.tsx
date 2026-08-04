import { type Metadata } from "next";
import { pageTitle } from "~/@/lib/typography";
import Link from "next/link";
import { Users } from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";
import { AUTHORS } from "~/@/data/authors";

export const metadata: Metadata = {
  title: "Authors & Contributors | Shorted",
  description:
    "Editorial team and contributors behind Shorted's ASX short-selling analysis. Backgrounds, expertise, and public profiles for every author who shapes the platform's coverage.",
  keywords: [
    "Shorted authors",
    "Shorted editorial team",
    "ASX short selling analysts",
    "Australian finance writers",
  ],
  openGraph: {
    title: "Authors & Contributors | Shorted",
    description:
      "Editorial team and contributors behind Shorted's ASX short-selling analysis.",
    url: `${siteConfig.url}/authors`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  twitter: {
    card: "summary_large_image",
    title: "Authors & Contributors | Shorted",
    description:
      "Editorial team and contributors behind Shorted's ASX short-selling analysis.",
  },
  alternates: {
    canonical: `${siteConfig.url}/authors`,
    languages: {
      "en-AU": `${siteConfig.url}/authors`,
      "en": `${siteConfig.url}/authors`,
      "x-default": `${siteConfig.url}/authors`,
    },
  },
};

export default function AuthorsIndexPage() {
  const breadcrumbItems = [{ label: "Authors", href: "/authors" }];

  const collectionSchema = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Authors & Contributors",
    description:
      "Editorial team behind Shorted's ASX short-selling coverage.",
    url: `${siteConfig.url}/authors`,
    isPartOf: {
      "@type": "WebSite",
      name: siteConfig.name,
      url: siteConfig.url,
    },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: AUTHORS.length,
      itemListElement: AUTHORS.map((a, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: `${siteConfig.url}/authors/${a.slug}`,
        name: a.name,
      })),
    },
  };

  return (
    <DashboardLayout>
      <BreadcrumbStructuredData items={breadcrumbItems} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(collectionSchema) }}
      />

      <section className="mb-4 flex items-center gap-3">
        <div className="rounded-lg bg-primary/10 p-2">
          <Users className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className={pageTitle}>
            Authors & Contributors
          </h1>
          <p className="text-sm text-muted-foreground">
            The editorial team and external contributors behind Shorted&apos;s
            ASX short-selling coverage.
          </p>
        </div>
      </section>

      <Breadcrumbs items={breadcrumbItems} />

      <ul className="mt-6 grid gap-4 md:grid-cols-2">
        {AUTHORS.map((a) => (
          <li key={a.slug}>
            <Link
              href={`/authors/${a.slug}`}
              className="group block rounded-xl border bg-card p-5 transition-[border-color,box-shadow] duration-200 ease-out hover:border-primary/40 hover:shadow-md"
            >
              <div className="flex items-start gap-4">
                {a.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={a.photoUrl}
                    alt=""
                    width={64}
                    height={64}
                    className="h-16 w-16 shrink-0 rounded-full bg-muted object-cover"
                  />
                ) : (
                  <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-muted text-xl font-semibold text-muted-foreground">
                    {a.name
                      .split(" ")
                      .map((n) => n[0])
                      .join("")
                      .slice(0, 2)}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-semibold tracking-tight group-hover:text-primary">
                    {a.name}
                  </h2>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">
                    {a.title}
                  </p>
                  <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">
                    {a.bio}
                  </p>
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>

      <p className="mt-8 text-xs text-muted-foreground">
        Author profiles are maintained for E-E-A-T transparency (Google
        Quality Rater Guidelines, Sept 2025 update). To contact the editorial
        team email <a href="mailto:editorial@shorted.com.au" className="underline">editorial@shorted.com.au</a>.
      </p>
    </DashboardLayout>
  );
}
