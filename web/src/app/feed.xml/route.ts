import { getAllPosts } from "~/@/lib/api";
import { siteConfig } from "~/@/config/site";

export async function GET() {
  const posts = getAllPosts();

  const escapeXml = (str: string) => {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  };

  const rssItems = posts.map((post) => {
    const postUrl = `${siteConfig.url}/blog/${post.slug}`;
    const pubDate = new Date(post.date).toUTCString();

    return `
    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${postUrl}</link>
      <guid isPermaLink="true">${postUrl}</guid>
      <description>${escapeXml(post.excerpt)}</description>
      <pubDate>${pubDate}</pubDate>
      <author>${escapeXml(post.author?.name ?? siteConfig.author)}</author>
    </item>`;
  }).join("");

  const rssFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(siteConfig.name)} Blog</title>
    <link>${siteConfig.url}/blog</link>
    <description>Short selling insights, market analysis, and updates on ASX short positions from ${siteConfig.name}</description>
    <language>en-AU</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${siteConfig.url}/feed.xml" rel="self" type="application/rss+xml"/>
    <image>
      <url>${siteConfig.url}/logo.png</url>
      <title>${escapeXml(siteConfig.name)} Blog</title>
      <link>${siteConfig.url}/blog</link>
    </image>
    ${rssItems}
  </channel>
</rss>`;

  return new Response(rssFeed, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}
