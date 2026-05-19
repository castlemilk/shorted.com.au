"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface EditorialMarkdownProps {
  content: string;
}

/**
 * Editorial-register markdown renderer for Shorted Take articles.
 *
 * Distinct from ChatMarkdown (which is terminal-aesthetic, monospace,
 * tight spacing) — this one uses the site's body font, generous line
 * height, and proper paragraph spacing. Single subject: one Take page.
 */
export function EditorialMarkdown({ content }: EditorialMarkdownProps) {
  return (
    <div className="prose prose-base dark:prose-invert max-w-none text-base leading-relaxed [&_p]:my-5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_a]:text-orange-400 [&_a:hover]:text-orange-300 [&_strong]:text-foreground [&_em]:italic">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
