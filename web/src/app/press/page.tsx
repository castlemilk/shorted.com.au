import { type Metadata } from "next";
import Link from "next/link";
import Image from "next/image";

import { siteConfig } from "~/@/config/site";
import { cn } from "~/@/lib/utils";
import { pageTitle, sectionTitle } from "~/@/lib/typography";
import { getShortStatistics } from "~/app/actions/getShortStatistics";
import { BreadcrumbStructuredData } from "~/@/components/seo/breadcrumbs";
import { EnhancedOrganizationSchema } from "~/@/components/seo/enhanced-structured-data";
import { CopyButton } from "~/@/components/docs/copy-button";

/**
 * Press & media kit.
 *
 * Exists so a journalist has ONE linkable page answering: what is this, what
 * may I republish, what do I cite, where are the logos, who do I email. The
 * citation lines here are the same ones on /statistics#cite and /data — this
 * page collects them rather than inventing a third wording.
 *
 * Deliberately honest about assets: we ship the PNG marks we actually have.
 * `public/logo 1.svg` is a 1MB SVG wrapping an embedded raster, i.e. not a
 * real vector, so it is NOT offered here as one.
 */

export const revalidate = 3600;

const PRESS_EMAIL = "ben@shorted.com.au";

export const metadata: Metadata = {
  title: "Press & Media Kit — Shorted.com.au",
  description:
    "Media resources for journalists covering ASX short selling: how to cite our data, what you may republish, logo downloads, embeddable charts, and media contact.",
  alternates: { canonical: `${siteConfig.url}/press` },
  openGraph: {
    title: "Press & Media Kit — Shorted.com.au",
    description:
      "How to cite Shorted.com.au, what you may republish, logos, embeddable charts and media contact.",
    url: `${siteConfig.url}/press`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
};

const LOGOS: Array<{
  label: string;
  file: string;
  note: string;
  dark?: boolean;
}> = [
  {
    label: "Primary logo",
    file: "/logo.png",
    note: "512 × 512 PNG — use where the full mark fits",
  },
  {
    label: "Minimal logo",
    file: "/logo-minimal.png",
    note: "PNG — simplified mark for small sizes",
  },
  {
    label: "Icon mark",
    file: "/assets/logo-mark-48.png",
    note: "48 × 48 PNG — favicons, avatars, inline credits",
  },
];

function formatAudLong(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)} billion`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)} million`;
  return `$${Math.round(n).toLocaleString("en-AU")}`;
}

export default async function PressPage() {
  const stats = await getShortStatistics();

  // The suggested-citation sentence mirrors /statistics#cite. When the live
  // numbers are unavailable (build shell / API down) we fall back to the
  // template rather than printing a wrong figure.
  const citation = stats
    ? `According to Shorted.com.au, ${formatAudLong(stats.totalDollarsShorted)} was short-sold across ${stats.stockCount} ASX-listed companies as of ${stats.asOfDate}, including ${formatAudLong(stats.bankBasketTotal)} against the big four banks.`
    : "According to Shorted.com.au, $X billion was short-sold across the ASX as of [date], including $Y billion against the big four banks.";

  const datasetCitation = `Shorted.com.au (${new Date().getFullYear()}). ASX Short Position Data, aggregated from ASIC daily short position reports. ${siteConfig.url}/data`;

  return (
    <main className="container mx-auto max-w-4xl px-4 py-10">
      {/* The component prepends Home itself. */}
      <BreadcrumbStructuredData
        items={[{ label: "Press & Media", href: "/press" }]}
      />
      {/* Organization schema belongs on the page describing the publisher.
          It was previously homepage-only. */}
      <EnhancedOrganizationSchema />

      <h1 className={pageTitle}>Press &amp; media kit</h1>
      <p className="mt-3 max-w-2xl text-muted-foreground">
        Shorted.com.au tracks short selling on the Australian Securities
        Exchange using official ASIC short position reports, with daily updates
        and history back to 2010. Journalists and researchers are welcome to
        cite and quote this data.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        Media enquiries:{" "}
        <a
          href={`mailto:${PRESS_EMAIL}`}
          className="underline underline-offset-4 hover:text-foreground"
        >
          {PRESS_EMAIL}
        </a>
      </p>

      {/* ---------------------------------------------------------------- */}
      <section className="mt-10" aria-labelledby="cite">
        <h2 id="cite" className={sectionTitle}>
          How to cite us
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          For a figure quoted in an article, cite the page you took it from and
          the date — our numbers move daily.
        </p>

        <div className="mt-4 rounded-lg border border-border/60 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Suggested wording
          </p>
          <div className="mt-2 flex items-start gap-3">
            <p className="flex-1 text-sm italic text-foreground">
              &ldquo;{citation}&rdquo;
            </p>
            <CopyButton value={citation} />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Please link to{" "}
            <Link
              href="/statistics"
              className="underline underline-offset-4 hover:text-foreground"
            >
              shorted.com.au/statistics
            </Link>
            .
          </p>
        </div>

        <div className="mt-4 rounded-lg border border-border/60 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Dataset citation (academic / research)
          </p>
          <div className="mt-2 flex items-start gap-3">
            <p className="flex-1 font-mono text-xs text-foreground">
              {datasetCitation}
            </p>
            <CopyButton value={datasetCitation} />
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="mt-10" aria-labelledby="usage">
        <h2 id="usage" className={sectionTitle}>
          What you may republish
        </h2>
        <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
          <li>
            <strong className="text-foreground">Our aggregate figures</strong> —
            totals, percentages and rankings derived from ASIC data — may be
            quoted freely with attribution and a link.
          </li>
          <li>
            <strong className="text-foreground">Our charts</strong> may be
            embedded live (see below) or screenshotted with a visible credit.
          </li>
          <li>
            <strong className="text-foreground">The underlying ASIC data</strong>{" "}
            is public. Our compiled datasets are offered under{" "}
            <a
              href="https://creativecommons.org/licenses/by/4.0/"
              className="underline underline-offset-4 hover:text-foreground"
              rel="noopener noreferrer"
              target="_blank"
            >
              CC BY 4.0
            </a>{" "}
            — attribute both Shorted.com.au and ASIC. See the{" "}
            <Link
              href="/data"
              className="underline underline-offset-4 hover:text-foreground"
            >
              open data hub
            </Link>
            .
          </li>
          <li>
            Read the{" "}
            <Link
              href="/methodology"
              className="underline underline-offset-4 hover:text-foreground"
            >
              methodology
            </Link>{" "}
            before quoting a figure — in particular the T+4 reporting delay,
            which means every number describes positions four trading days
            earlier.
          </li>
        </ul>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="mt-10" aria-labelledby="embed">
        <h2 id="embed" className={sectionTitle}>
          Embeddable charts
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Every chart and table below carries an{" "}
          <span className="font-medium text-foreground">Embed</span> button that
          copies a ready-made snippet. The widgets update daily on their own —
          no maintenance once published.
        </p>
        <ul className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          {[
            { href: "/top", label: "Most shorted ASX stocks (table)" },
            { href: "/statistics", label: "Big-four bank short basket" },
            { href: "/", label: "Short positions by industry (heatmap)" },
            { href: "/shorts/BHP", label: "Any single stock's history (chart)" },
          ].map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="underline underline-offset-4 hover:text-foreground"
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="mt-10" aria-labelledby="logos">
        <h2 id="logos" className={sectionTitle}>
          Logos
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Please don&apos;t stretch, recolour or add effects to the mark. Leave
          clear space around it of at least the height of the icon.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {LOGOS.map((logo) => (
            <div
              key={logo.file}
              className="rounded-lg border border-border/60 p-4"
            >
              <div className="flex h-24 items-center justify-center rounded bg-muted/40">
                <Image
                  src={logo.file}
                  alt={`Shorted.com.au ${logo.label.toLowerCase()}`}
                  width={64}
                  height={64}
                  className="h-16 w-16 object-contain"
                />
              </div>
              <p className="mt-3 text-sm font-medium text-foreground">
                {logo.label}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {logo.note}
              </p>
              <a
                href={logo.file}
                download
                className="mt-2 inline-block text-xs underline underline-offset-4 hover:text-foreground"
              >
                Download PNG
              </a>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Need a vector or a specific size? Email{" "}
          <a
            href={`mailto:${PRESS_EMAIL}`}
            className="underline underline-offset-4 hover:text-foreground"
          >
            {PRESS_EMAIL}
          </a>
          .
        </p>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="mt-10" aria-labelledby="facts">
        <h2 id="facts" className={sectionTitle}>
          Quick facts
        </h2>
        <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[
            ["Data source", "ASIC daily short position reports"],
            ["Coverage", "4,500+ ASX-listed securities, 2010 to present"],
            ["Update cadence", "Daily, with ASIC's T+4 trading day delay"],
            ["Licence", "CC BY 4.0 for our compiled datasets"],
            [
              "Total short-sold",
              stats ? formatAudLong(stats.totalDollarsShorted) : "See /statistics",
            ],
            ["As at", stats?.asOfDate ?? "See /statistics"],
          ].map(([term, value]) => (
            <div
              key={term}
              className={cn(
                "rounded-lg border border-border/60 p-3",
                "flex flex-col gap-0.5",
              )}
            >
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                {term}
              </dt>
              <dd className="text-sm font-medium text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="mt-10" aria-labelledby="contact">
        <h2 id="contact" className={sectionTitle}>
          Contact
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Shorted.com.au is built and run by Ben Ebsworth. For data questions,
          interview requests, a custom cut of the data, or corrections, email{" "}
          <a
            href={`mailto:${PRESS_EMAIL}`}
            className="underline underline-offset-4 hover:text-foreground"
          >
            {PRESS_EMAIL}
          </a>
          . Corrections are welcome and acted on quickly — if a figure looks
          wrong, please say so before publishing.
        </p>
      </section>
    </main>
  );
}
