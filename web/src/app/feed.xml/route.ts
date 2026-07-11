import { getAllPosts } from "~/@/lib/api";
import { siteConfig } from "~/@/config/site";
import { getAvailableWeekSlugs } from "~/app/actions/reports/getReportData";
import { listEditorialTakes } from "~/app/actions/getEditorialTake";

export const revalidate = 3600;

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function weekSlugToDate(slug: string): Date {
  const match = slug.match(/^(\d{4})-W(\d{2})$/);
  if (!match?.[1] || !match[2]) return new Date();
  const year = parseInt(match[1]);
  const week = parseInt(match[2]);
  // ISO week date: Jan 4 is always in week 1
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dayOfWeek + 1 + (week - 1) * 7);
  // Use Friday of that week as publication date
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  return friday;
}

function formatWeekTitle(slug: string): string {
  const match = slug.match(/^(\d{4})-W(\d{2})$/);
  if (!match?.[1] || !match[2]) return slug;
  return `Week ${parseInt(match[2])}, ${match[1]}`;
}

// Strip markdown/MDX to plain text for a feed description (~200 chars)
function takeDescription(bodyMd: string): string {
  const text = bodyMd
    .replace(/^import\s.+$/gm, "") // MDX import statements
    .replace(/^export\s.+$/gm, "") // MDX export statements
    .replace(/<[^>]+>/g, " ") // JSX/HTML tags
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → link text
    .replace(/\[(?:ref|report)-\d+\]/g, "") // citation markers
    .replace(/[#*_`>|]/g, "") // md tokens
    .replace(/\s+/g, " ")
    .trim();
  const MAX = 200;
  if (text.length <= MAX) return text;
  const cut = text.slice(0, MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 120 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

// Feed item with its publication date so all sources can be merged + sorted
interface FeedItem {
  date: Date;
  xml: string;
}

export async function GET() {
  const posts = getAllPosts();

  const blogItems: FeedItem[] = posts.map((post) => {
    const postUrl = `${siteConfig.url}/blog/${post.slug}`;
    const date = new Date(post.date);

    return {
      date,
      xml: `
    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${postUrl}</link>
      <guid isPermaLink="true">${postUrl}</guid>
      <description>${escapeXml(post.excerpt)}</description>
      <pubDate>${date.toUTCString()}</pubDate>
      <author>${escapeXml(post.author?.name ?? siteConfig.author)}</author>
      <category>Blog</category>
    </item>`,
    };
  });

  // Add editorial takes (/news/{slug}) to the feed
  let takeItems: FeedItem[] = [];
  try {
    const takesResp = await listEditorialTakes(20, 0, "");
    takeItems = (takesResp?.takes ?? []).flatMap((take): FeedItem[] => {
      // Only published takes carry a publishedAt — skip the rest
      const seconds = take.publishedAt?.seconds;
      const secNum =
        typeof seconds === "bigint"
          ? Number(seconds)
          : typeof seconds === "number"
            ? seconds
            : 0;
      if (!secNum) return [];
      const date = new Date(secNum * 1000);
      const takeUrl = `${siteConfig.url}/news/${take.slug}`;

      return [
        {
          date,
          xml: `
    <item>
      <title>${escapeXml(take.headline)}</title>
      <link>${takeUrl}</link>
      <guid isPermaLink="true">${takeUrl}</guid>
      <description>${escapeXml(takeDescription(take.bodyMd))}</description>
      <pubDate>${date.toUTCString()}</pubDate>
      <author>${escapeXml(siteConfig.author)}</author>
      <category>Shorted Take</category>
    </item>`,
        },
      ];
    });
  } catch {
    // If take fetching fails, continue without editorial items
  }

  // Add weekly reports to the feed
  let reportItems: FeedItem[] = [];
  try {
    const weekSlugs = await getAvailableWeekSlugs();
    reportItems = weekSlugs.slice(0, 12).map((slug) => {
      const reportUrl = `${siteConfig.url}/reports/weekly/${slug}`;
      const date = weekSlugToDate(slug);
      const title = `ASX Short Selling Weekly Report - ${formatWeekTitle(slug)}`;
      const description = `Weekly analysis of ASX short selling activity for ${formatWeekTitle(slug)}. Top movers, industry trends, and aggregate short interest from official ASIC data.`;

      return {
        date,
        xml: `
    <item>
      <title>${escapeXml(title)}</title>
      <link>${reportUrl}</link>
      <guid isPermaLink="true">${reportUrl}</guid>
      <description>${escapeXml(description)}</description>
      <pubDate>${date.toUTCString()}</pubDate>
      <author>${escapeXml(siteConfig.author)}</author>
      <category>Weekly Report</category>
    </item>`,
      };
    });
  } catch {
    // If report fetching fails, continue with just blog posts
  }

  const allItems = [...blogItems, ...takeItems, ...reportItems]
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .map((item) => item.xml)
    .join("");

  const rssFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(siteConfig.name)} - ASX Short Selling Data &amp; Analysis</title>
    <link>${siteConfig.url}</link>
    <description>Short selling insights, weekly reports, market analysis, and updates on ASX short positions from ${siteConfig.name}. Official ASIC data updated daily.</description>
    <language>en-AU</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${siteConfig.url}/feed.xml" rel="self" type="application/rss+xml"/>
    <image>
      <url>${siteConfig.url}/logo.png</url>
      <title>${escapeXml(siteConfig.name)}</title>
      <link>${siteConfig.url}</link>
    </image>
    ${allItems}
  </channel>
</rss>`;

  return new Response(rssFeed, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}
