"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DROP_CAP_CONTAINER, firstProseBlockIndex } from "./drop-cap";
import { sectionTitle } from "~/@/lib/typography";
import { ArticleTable } from "~/@/components/mdx/article-table";

const ARTICLE_ELEMENTS = {
  h1: ({ children }: { children?: React.ReactNode }) => <h2 className={sectionTitle}>{children}</h2>,
  h2: ({ children }: { children?: React.ReactNode }) => <h2 className={sectionTitle}>{children}</h2>,
  h3: ({ children }: { children?: React.ReactNode }) => <h3 className="font-mono text-xl font-semibold leading-snug">{children}</h3>,
  h4: ({ children }: { children?: React.ReactNode }) => <h4 className="font-mono text-lg font-semibold leading-snug">{children}</h4>,
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => <a href={href} className="text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary">{children}</a>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="list-disc pl-6">{children}</ul>,
  ol: ({ children }: { children?: React.ReactNode }) => <ol className="list-decimal pl-6">{children}</ol>,
  blockquote: ({ children }: { children?: React.ReactNode }) => <blockquote className="border-l border-primary/50 pl-5 text-muted-foreground">{children}</blockquote>,
  table: ({ node: _node, ...props }: React.ComponentPropsWithoutRef<"table"> & { node?: unknown }) => <ArticleTable {...props} />,
  th: ({ children, style }: React.ComponentPropsWithoutRef<"th">) => <th style={style} className="border-b border-border px-4 py-3 text-left font-mono text-sm font-semibold">{children}</th>,
  td: ({ children, style }: React.ComponentPropsWithoutRef<"td">) => <td style={style} className="border-b border-border px-4 py-3 font-mono text-sm tabular-nums">{children}</td>,
};

export interface InlineImage {
  url: string;
  topic?: string;
  alt?: string;
}

interface EditorialMarkdownProps {
  content: string;
  inlineImages?: InlineImage[];
}

/**
 * Editorial-register markdown renderer for Shorted Take articles.
 *
 * Optionally interleaves inline_images between paragraph chunks of the
 * body. Splits the markdown on blank-line paragraph boundaries and
 * inserts each inline image between successive groups, evenly spaced.
 *
 * If no inline images are passed, behaves as a plain markdown render.
 */
export function EditorialMarkdown({ content, inlineImages = [] }: EditorialMarkdownProps) {
  const proseClasses = "article-prose";

  if (inlineImages.length === 0) {
    return (
      <div className={`${proseClasses} ${DROP_CAP_CONTAINER}`}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={ARTICLE_ELEMENTS}>{content}</ReactMarkdown>
      </div>
    );
  }

  // Split body into paragraph blocks (separated by blank lines), then
  // distribute images evenly between them. With 4 paragraphs and 2
  // images the layout is: P1, IMG1, P2, P3, IMG2, P4.
  const blocks = content.split(/\n\s*\n/).filter((b) => b.trim().length > 0);
  const segmentsPerImage = Math.max(1, Math.floor(blocks.length / (inlineImages.length + 1)));
  // Each block renders in its own div, so apply the drop cap to the
  // first block that is actually prose (the body may open with a heading).
  const firstProseIdx = firstProseBlockIndex(blocks);
  const nodes: React.ReactNode[] = [];
  let imgIdx = 0;
  for (let i = 0; i < blocks.length; i++) {
    nodes.push(
      <div
        key={`p-${i}`}
        className={i === firstProseIdx ? `${proseClasses} ${DROP_CAP_CONTAINER}` : proseClasses}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={ARTICLE_ELEMENTS}>{blocks[i]!}</ReactMarkdown>
      </div>,
    );
    const nextBoundary = (i + 1) * (1 / (segmentsPerImage + 1));
    if (
      imgIdx < inlineImages.length &&
      (i + 1) % segmentsPerImage === 0 &&
      i < blocks.length - 1
    ) {
      const img = inlineImages[imgIdx]!;
      nodes.push(
        <figure key={`img-${imgIdx}`} className="my-6 overflow-hidden rounded-lg border border-border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={img.url}
            alt={img.alt ?? img.topic ?? "Inline editorial illustration"}
            className="h-auto w-full"
          />
        </figure>,
      );
      imgIdx++;
    }
    void nextBoundary; // unused placeholder; kept for clarity
  }
  // If any images remain (e.g. more images than gaps), drop them at the end.
  while (imgIdx < inlineImages.length) {
    const img = inlineImages[imgIdx]!;
    nodes.push(
      <figure key={`img-tail-${imgIdx}`} className="my-6 overflow-hidden rounded-lg border border-border">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={img.url}
          alt={img.alt ?? img.topic ?? "Inline editorial illustration"}
          className="h-auto w-full"
        />
      </figure>,
    );
    imgIdx++;
  }
  return <>{nodes}</>;
}
