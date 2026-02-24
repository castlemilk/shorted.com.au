import { NextResponse } from "next/server";
import { getPostBySlug } from "~/@/lib/api";
import { siteConfig } from "~/@/config/site";
import {
  calculateReadingTime,
  formatReadingTime,
} from "~/@/utils/reading-time";

/**
 * Strip MDX/markdown formatting to produce clean, readable plain text.
 * Preserves structural hierarchy using markdown headings but removes
 * JSX components, HTML tags, and other non-textual elements.
 */
function mdxToCleanMarkdown(content: string): string {
  return (
    content
      // Remove JSX component blocks like <RegisterEmail ... /> or <Info title="...">...</Info>
      .replace(/<[A-Z][A-Za-z]*\b[^>]*\/>/g, "")
      .replace(/<[A-Z][A-Za-z]*\b[^>]*>[\s\S]*?<\/[A-Z][A-Za-z]*>/g, "")
      // Remove HTML img tags but keep alt text
      .replace(/<img[^>]*alt="([^"]*)"[^>]*\/?>/g, "[$1]")
      .replace(/<img[^>]*\/?>/g, "")
      // Remove remaining HTML tags
      .replace(/<[^>]+>/g, "")
      // Remove import statements
      .replace(/^import\s+.*$/gm, "")
      // Remove export statements
      .replace(/^export\s+.*$/gm, "")
      // Clean up excessive blank lines
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

export async function GET(
  _request: Request,
  { params }: { params: { slug: string } },
) {
  const post = getPostBySlug(params.slug);

  if (!post) {
    return NextResponse.json(
      { error: "Blog post not found" },
      { status: 404 },
    );
  }

  const readingTime = calculateReadingTime(String(post.content));
  const postUrl = `${siteConfig.url}/blog/${params.slug}`;
  const cleanContent = mdxToCleanMarkdown(post.content);
  const publishedDate = new Date(post.date).toLocaleDateString("en-AU", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const plainText = `---
title: ${post.title}
author: ${post.author?.name || siteConfig.author}
date: ${publishedDate}
reading_time: ${formatReadingTime(readingTime)}
url: ${postUrl}
source: ${siteConfig.name} (${siteConfig.url})
---

${post.excerpt ? `> ${post.excerpt}\n\n` : ""}${cleanContent}

---

Published by ${siteConfig.name} (${siteConfig.url})
This article is part of the Shorted blog, covering ASX short selling insights and market analysis.
For more articles, visit: ${siteConfig.url}/blog
For LLM-optimised site documentation, see: ${siteConfig.url}/llms.txt
`;

  return new NextResponse(plainText, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
      "X-Robots-Tag": "index, follow",
      "X-LLM-Friendly": "true",
      "X-AI-Indexable": "true",
    },
  });
}
