import { type Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  Breadcrumbs,
  BreadcrumbStructuredData,
} from "~/@/components/seo/breadcrumbs";
import { LLMMeta } from "~/@/components/seo/llm-meta";
import { EditorialMarkdown } from "~/@/components/news/editorial-markdown";
import { TakeRelated } from "~/@/components/news/take-related";
import { getEditorialTake } from "~/app/actions/getEditorialTake";

export const revalidate = 600;

interface Params {
  params: Promise<{ slug: string }>;
}

async function loadTake(slug: string) {
  const resp = await getEditorialTake(slug);
  return resp?.take;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const take = await loadTake(slug);
  if (!take) {
    return { title: "Not found | Shorted" };
  }
  const url = `${siteConfig.url}/news/${slug}`;
  const description = take.bodyMd
    .replace(/[#*_`>\-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  const image =
    take.heroImageUrl ||
    take.ogImageUrl ||
    `${siteConfig.url}/news/${slug}/opengraph-image`;
  return {
    title: `${take.headline} | Shorted Take`,
    description,
    openGraph: {
      title: take.headline,
      description,
      url,
      siteName: siteConfig.name,
      type: "article",
      locale: "en_AU",
      images: [{ url: image, width: 1200, height: 630, alt: take.headline }],
    },
    twitter: {
      card: "summary_large_image",
      title: take.headline,
      description,
      images: [image],
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

export default async function ShortedTakePage({ params }: Params) {
  const { slug } = await params;
  const take = await loadTake(slug);
  if (!take) return notFound();

  // protobuf-es serialises Timestamp.seconds as bigint over the wire but
  // some transports / cache layers coerce it to number. Handle both.
  const pubSeconds = take.publishedAt?.seconds;
  const publishedDate =
    typeof pubSeconds === "bigint"
      ? new Date(Number(pubSeconds) * 1000)
      : typeof pubSeconds === "number"
        ? new Date(pubSeconds * 1000)
        : undefined;
  const publishedISO = publishedDate?.toISOString() ?? "";
  const publishedLabel = publishedDate
    ? publishedDate.toLocaleDateString("en-AU", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : "";

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

      <div className="mx-auto max-w-4xl px-4 py-8">
        <Breadcrumbs items={breadcrumbItems} className="mb-6" />

        {take.heroImageUrl ? (
          <figure className="mb-8 overflow-hidden rounded-lg border border-border">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={take.heroImageUrl}
              alt={take.headline}
              width={1536}
              height={1024}
              className="h-auto w-full"
            />
          </figure>
        ) : null}

        <header className="mb-8 border-b border-border pb-6">
          <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-wider text-orange-400">
            <span>Shorted Take</span>
            {take.stockCode ? (
              <>
                <span className="text-muted-foreground">·</span>
                <Link
                  href={`/shorts/${take.stockCode}`}
                  className="font-bold text-orange-300 hover:text-orange-200"
                >
                  ${take.stockCode}
                </Link>
              </>
            ) : null}
          </div>
          <h1 className="mb-4 text-3xl font-bold leading-tight md:text-4xl">
            {take.headline}
          </h1>
          {publishedLabel ? (
            <time
              dateTime={publishedISO}
              className="text-sm text-muted-foreground"
            >
              Published {publishedLabel}
            </time>
          ) : null}
        </header>

        <article className="mb-12">
          <EditorialMarkdown
            content={take.bodyMd}
            inlineImages={(take.inlineImages ?? []).map((i) => ({
              url: i.url,
              topic: i.topic,
              alt: i.alt,
            }))}
          />
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
