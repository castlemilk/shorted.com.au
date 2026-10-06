import { NextResponse } from "next/server";
import { getPostBySlug } from "~/@/lib/api";
import { siteConfig } from "~/@/config/site";
import { mdxToCleanMarkdown } from "~/@/lib/blog/clean-markdown";
import {
  calculateReadingTime,
  formatReadingTime,
} from "~/@/utils/reading-time";

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
