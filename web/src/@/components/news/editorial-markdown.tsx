"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DROP_CAP_CONTAINER, firstProseBlockIndex } from "./drop-cap";

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
  const proseClasses =
    "prose prose-base dark:prose-invert max-w-none text-base leading-relaxed [&_p]:my-5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_a]:text-orange-400 [&_a:hover]:text-orange-300 [&_strong]:text-foreground [&_em]:italic";

  if (inlineImages.length === 0) {
    return (
      <div className={`${proseClasses} ${DROP_CAP_CONTAINER}`}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
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
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{blocks[i]!}</ReactMarkdown>
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
