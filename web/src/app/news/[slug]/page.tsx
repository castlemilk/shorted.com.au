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
import { formatCompanyName } from "~/@/lib/company-name";
import { getEditorialTakeOrNotFound } from "~/app/actions/getEditorialTake";
import { getStock } from "~/app/actions/getStock";
import { NotFoundError } from "~/app/actions/withRetry";
import { type GetEditorialTakeResponse } from "~/gen/shorts/v1alpha1/news_pb";
import { JsonLd } from "~/@/components/seo/json-ld";
import { safeExternalHref } from "~/@/lib/safe-external-href";

// On-demand ISR: nothing renders at build, and each take generates on its
// first request and is cached for 600 s. Without generateStaticParams the
// revalidate was inert and every take rendered per request
// (app/__tests__/isr-static-params.test.ts). Safe because loadTake fails the
// render on a failed read (app/__tests__/isr-degraded-render.test.ts).
export const revalidate = 600;
export const dynamicParams = true;
export function generateStaticParams(): Array<{ slug: string }> {
  return [];
}

interface Params {
  params: Promise<{ slug: string }>;
}

/**
 * The take, split by cause (loadStockOrFail's rule). Undefined for a slug the
 * API does not know, which is a 404. A failed read THROWS: ISR caches whatever
 * a regeneration renders, so answering it with notFound() put a 404 and a
 * noindex "Take not found" title in place of a live take for 600 s, where a
 * failed regeneration keeps serving the last good page. generateMetadata and
 * the page make the same call, so React's cache reads once. Any other error
 * propagates untouched.
 */
async function loadTake(slug: string): Promise<GetEditorialTakeResponse["take"]> {
  let resp: GetEditorialTakeResponse | undefined;
  try {
    resp = await getEditorialTakeOrNotFound(slug);
  } catch (err) {
    if (err instanceof NotFoundError) return undefined;
    throw err;
  }
  if (!resp) {
    throw new Error(
      `editorial take transiently unavailable for ${slug}; failing the ISR render instead of caching a 404`,
    );
  }
  return resp.take;
}

/**
 * An MDX component or HTML tag, opening, closing or self-closing. Quoted
 * attribute values may hold a ">" (`<Stat context="a > b" />`).
 */
const MARKUP_TAG = /<\/?[A-Za-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*\/?>/g;

/**
 * Build a short, social-share-friendly description from the body. The
 * raw body_md contains [ref-N]/[report-N] citation markers, Markdown links
 * and tokens, MDX components, and is multiple paragraphs — none of which are
 * useful in a 155-char SERP preview. We strip everything, take the first
 * paragraph with text left in it (the editorial hook; an MDX body can open
 * with a component block), and truncate at a word boundary if needed.
 *
 * A link keeps its text: eight of the 11 staged takes open with one, and every
 * probed snippet read "[Boss Energy](/shorts/BOE) was…" (2026-10-21).
 */
function buildDescription(bodyMd: string): string {
  const clean =
    bodyMd
      .split(/\n\s*\n/)
      .map((paragraph) =>
        paragraph
          .replace(/\[(?:ref|report)-\d+\]/g, "") // citation markers
          .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
          .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links keep their text
          .replace(MARKUP_TAG, "") // MDX components, HTML tags
          .replace(/[#*_`>]/g, "") // md tokens
          .replace(/\s+/g, " ")
          .replace(/\s+([.,;:!?])/g, "$1") // a removed marker's space
          .trim(),
      )
      .find((paragraph) => paragraph.length > 0) ?? "";
  // SERP descriptions truncate around 155-160 chars. Trim at word
  // boundary just before that.
  const MAX = 155;
  if (clean.length <= MAX) return clean;
  const cut = clean.slice(0, MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 100 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

/**
 * Past this a headline is cut to its first clause, when that clause reads
 * alone. "<headline> — Shorted Take | Shorted" ran 96-115 characters
 * (2026-10-21) against the ~60 Google shows.
 */
const TAKE_TITLE_MAX = 80;

/**
 * The take's <title>: the headline, or for a long one its first clause ("EOS
 * short position more than doubled to 10.15% in a quarter; the price rose 25%
 * in a month" keeps the 59 characters before the semicolon). A long headline
 * with no clause break stays whole: cutting it mid-phrase would show no more
 * than Google's own truncation does, and would drop words from the title.
 */
function takeTitle(headline: string): string {
  if (headline.length <= TAKE_TITLE_MAX) return headline;
  const clause = headline.split(/;\s+|\s+[—–]\s+/)[0]?.trim() ?? "";
  return clause.length >= 30 && clause.length <= 70 ? clause : headline;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const take = await loadTake(slug);
  if (!take) {
    // A slug the API does not know: loadTake throws on a failed read, so this
    // is never a transient miss. Root layout template handles the "| Shorted"
    // suffix. The page body notFound()s, but the 404 status can be pre-empted
    // once the response has streamed — noindex it so a soft-200 never enters
    // the index.
    return {
      title: "Take not found",
      robots: { index: false, follow: false },
    };
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
    // Absolute: the headline alone, without the root template's
    // " | Shorted" or a " — Shorted Take" qualifier. Google names the site
    // beside every result, and the brand pushed the headline past the width
    // results show. The social titles keep the full headline.
    title: { absolute: takeTitle(take.headline) },
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
  // The company the take is about, named as the stock pages name it.
  // TakeRelated below reads the same stock, so React's cache makes this one
  // read; a failed read names it by its code.
  const stock = take.stockCode
    ? await getStock(take.stockCode).catch(() => undefined)
    : undefined;
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
        url: siteConfig.logo.url,
        width: siteConfig.logo.width,
        height: siteConfig.logo.height,
      },
    },
    isAccessibleForFree: true,
    inLanguage: "en-AU",
    ...(take.stockCode
      ? {
          about: {
            "@type": "Corporation",
            name: formatCompanyName(stock?.name, take.stockCode),
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
      <JsonLd data={newsArticleSchema} />

      <div className="mx-auto max-w-4xl px-4 py-8">
        <Breadcrumbs items={breadcrumbItems} className="mb-6" />

        <ArticleHeader take={take} />

        {/* Drop cap is applied inside the body renderers (see drop-cap.ts) —
            the three render paths nest their first paragraph differently. */}
        <article className="mx-auto mb-12 max-w-2xl">
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
          <footer className="mx-auto max-w-2xl rounded-lg border border-border bg-muted/30 p-5 text-sm">
            <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
              Source
            </div>
            <div>
              Originally reported by{" "}
              <a
                href={safeExternalHref(take.sourceUrl)}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-primary hover:underline"
              >
                {take.sourceName || take.sourceUrl}
              </a>
              . This Shorted Take is editorial commentary, not the original
              article.
            </div>
          </footer>
        ) : null}

        <div className="mx-auto mt-8 max-w-2xl text-xs italic leading-relaxed text-muted-foreground">
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
