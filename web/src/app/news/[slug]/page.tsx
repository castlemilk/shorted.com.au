import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";
import { LLMMeta } from "~/@/components/seo/llm-meta";
import { ArticleHeader } from "~/@/components/news/article-header";
import { EditorialMarkdown } from "~/@/components/news/editorial-markdown";
import { TakeRelated } from "~/@/components/news/take-related";
import { TakeBody } from "~/@/components/news/take-body";
import { MdxTakeBody } from "~/@/components/news/mdx-take-body";
import { getEditorialTake } from "~/app/actions/getEditorialTake";

export const revalidate = 600;

interface Params {
  params: Promise<{ slug: string }>;
}

async function loadTake(slug: string) {
  const resp = await getEditorialTake(slug);
  return resp?.take;
}

/**
 * Build a short, social-share-friendly description from the body. The
 * raw body_md contains [ref-N]/[report-N] citation markers, markdown
 * tokens, and is multiple paragraphs — none of which are useful in a
 * 155-char SERP preview. We strip everything, take the first paragraph
 * (the editorial hook), and truncate at a word boundary if needed.
 */
function buildDescription(bodyMd: string): string {
  const firstPara = bodyMd.split(/\n\s*\n/)[0] ?? bodyMd;
  const clean = firstPara
    .replace(/\[(?:ref|report)-\d+\]/g, "") // citation markers
    .replace(/[#*_`>]/g, "") // md tokens
    .replace(/\s+/g, " ")
    .trim();
  // SERP descriptions truncate around 155-160 chars. Trim at word
  // boundary just before that.
  const MAX = 155;
  if (clean.length <= MAX) return clean;
  const cut = clean.slice(0, MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 100 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const take = await loadTake(slug);
  if (!take) {
    // Root layout template handles the "| Shorted" suffix.
    return { title: "Take not found" };
  }
  const url = `${siteConfig.url}/news/${slug}`;
  const description = buildDescription(take.bodyMd);

  // Use the auto-generated /news/[slug]/opengraph-image route as the
  // social card — it composes the hero, headline, ticker, sentiment,
  // sources count, and brand chrome at the correct 1200x630. Falling
  // back to the raw hero PNG only if the route is unavailable.
  const image = `${siteConfig.url}/news/${slug}/opengraph-image`;
  const publishedSeconds = take.publishedAt?.seconds;
  const publishedISO =
    typeof publishedSeconds === "bigint"
      ? new Date(Number(publishedSeconds) * 1000).toISOString()
      : typeof publishedSeconds === "number"
        ? new Date(publishedSeconds * 1000).toISOString()
        : undefined;

  return {
    // Root layout applies '%s | Shorted' template. Append "Shorted Take"
    // qualifier without the brand suffix.
    title: `${take.headline} — Shorted Take`,
    description,
    openGraph: {
      title: take.headline,
      description,
      url,
      siteName: siteConfig.name,
      type: "article",
      locale: "en_AU",
      publishedTime: publishedISO,
      authors: ["Shorted"],
      tags: take.stockCode ? [take.stockCode, "ASX", "Short selling"] : ["ASX", "Short selling"],
      images: [{ url: image, width: 1200, height: 630, alt: take.headline }],
    },
    twitter: {
      card: "summary_large_image",
      title: take.headline,
      description,
      images: [image],
      site: "@shorted___",
      creator: "@shorted___",
    },
    alternates: {
      canonical: url,
      languages: {
        "en-AU": url,
        en: url,
        "x-default": url,
      },
    },
  };
}

function toISO(seconds: bigint | number | undefined): string | undefined {
  if (typeof seconds === "bigint") return new Date(Number(seconds) * 1000).toISOString();
  if (typeof seconds === "number") return new Date(seconds * 1000).toISOString();
  return undefined;
}

export default async function ShortedTakePage({ params }: Params) {
  const { slug } = await params;
  const take = await loadTake(slug);
  if (!take) return notFound();

  const url = `${siteConfig.url}/news/${slug}`;
  const publishedISO = toISO(take.publishedAt?.seconds);
  // Original editorial content — NewsArticle is the highest-value schema on
  // the site. Author/publisher are the Organization (not a fake Person).
  const newsArticleSchema = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: take.headline.slice(0, 110),
    description: buildDescription(take.bodyMd),
    url,
    mainEntityOfPage: url,
    image: [`${siteConfig.url}/news/${slug}/opengraph-image`],
    ...(publishedISO
      ? { datePublished: publishedISO, dateModified: publishedISO }
      : {}),
    author: {
      "@type": "Organization",
      name: "Shorted",
      url: `${siteConfig.url}/about`,
    },
    publisher: {
      "@type": "Organization",
      name: "Shorted",
      url: siteConfig.url,
      logo: {
        "@type": "ImageObject",
        url: `${siteConfig.url}/logo.png`,
        width: 512,
        height: 512,
      },
    },
    isAccessibleForFree: true,
    inLanguage: "en-AU",
    ...(take.stockCode
      ? {
          about: {
            "@type": "Corporation",
            tickerSymbol: take.stockCode,
            sameAs: `https://www.asx.com.au/markets/company/${take.stockCode}`,
          },
        }
      : {}),
  };

  const breadcrumbItems = [
    { label: "News", href: "/news" },
    ...(take.stockCode
      ? [{ label: take.stockCode, href: `/shorts/${take.stockCode}/news` }]
      : []),
    { label: take.headline, href: `/news/${slug}` },
  ];

  return (
    <DashboardLayout>
      <LLMMeta
        title={take.headline}
        description={take.headline}
        dataSource="ASIC short-position data + Australian news publishers"
      />
      <BreadcrumbStructuredData items={breadcrumbItems} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(newsArticleSchema) }}
      />

      <div className="mx-auto max-w-4xl px-4 py-8">
        <Breadcrumbs items={breadcrumbItems} className="mb-6" />

        <ArticleHeader take={take} />

        {/* Drop cap is applied inside the body renderers (see drop-cap.ts) —
            the three render paths nest their first paragraph differently. */}
        <article className="mb-12">
          {take.bodyFormat === "mdx" ? (
            <MdxTakeBody
              body={take.bodyMd}
              citations={(take.citations ?? []).map((c) => ({
                refId: c.refId,
                url: c.url,
                source: c.source,
                headline: c.headline,
                date: c.date,
                type: c.type,
              }))}
              layoutImages={(take.layoutImages ?? []).map((li) => ({
                url: li.url,
                caption: li.caption,
                placement: li.placement,
                anchorAfterBlock: li.anchorAfterBlock,
              }))}
            />
          ) : take.citations && take.citations.length > 0 ? (
            <TakeBody
              bodyMd={take.bodyMd}
              citations={take.citations.map((c) => ({
                refId: c.refId,
                url: c.url,
                source: c.source,
                headline: c.headline,
                date: c.date,
                type: c.type,
              }))}
              inlineImages={(take.inlineImages ?? []).map((i) => ({
                url: i.url,
                topic: i.topic,
                alt: i.alt,
              }))}
              layoutImages={(take.layoutImages ?? []).map((li) => ({
                url: li.url,
                style: li.style,
                ratio: li.ratio,
                brief: li.brief,
                caption: li.caption,
                placement: li.placement,
                anchorAfterBlock: li.anchorAfterBlock,
              }))}
              stockCode={take.stockCode}
            />
          ) : (
            <EditorialMarkdown
              content={take.bodyMd}
              inlineImages={(take.inlineImages ?? []).map((i) => ({
                url: i.url,
                topic: i.topic,
                alt: i.alt,
              }))}
            />
          )}
        </article>

        {take.sourceUrl ? (
          <footer className="rounded-lg border border-border bg-muted/30 p-5 text-sm">
            <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
              Source
            </div>
            <div>
              Originally reported by{" "}
              <a
                href={take.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-orange-400 hover:text-orange-300"
              >
                {take.sourceName || take.sourceUrl}
              </a>
              . This Shorted Take is editorial commentary, not the original
              article.
            </div>
          </footer>
        ) : null}

        <div className="mt-8 text-xs italic text-muted-foreground">
          Not financial advice. Sourced from official ASIC short-position data
          and public news reports.
        </div>

        {take.stockCode ? (
          <TakeRelated stockCode={take.stockCode} excludeSlug={slug} />
        ) : null}
      </div>
    </DashboardLayout>
  );
}
