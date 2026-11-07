"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * A rendered view of one private doc. Plain markdown and GitHub tables; links
 * open in a new tab. Kept in its own module so tests can stand in for it.
 */
const ELEMENTS = {
  h1: ({ children }: { children?: React.ReactNode }) => <h2 className="mt-2 text-2xl font-bold">{children}</h2>,
  h2: ({ children }: { children?: React.ReactNode }) => <h3 className="mt-8 border-b pb-1 text-xl font-semibold">{children}</h3>,
  h3: ({ children }: { children?: React.ReactNode }) => <h4 className="mt-6 text-lg font-semibold">{children}</h4>,
  h4: ({ children }: { children?: React.ReactNode }) => <h5 className="mt-5 font-mono text-sm font-semibold">{children}</h5>,
  p: ({ children }: { children?: React.ReactNode }) => <p className="my-3 leading-relaxed">{children}</p>,
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-4">
      {children}
    </a>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="my-3 list-disc space-y-1 pl-6">{children}</ul>,
  ol: ({ children }: { children?: React.ReactNode }) => <ol className="my-3 list-decimal space-y-1 pl-6">{children}</ol>,
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="my-3 overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">{children}</pre>
  ),
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) =>
    className ? <code className={className}>{children}</code> : <code className="rounded bg-muted px-1 font-mono text-[0.85em]">{children}</code>,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: React.ReactNode }) => <th className="border-b px-3 py-2 text-left font-semibold">{children}</th>,
  td: ({ children }: { children?: React.ReactNode }) => <td className="border-b px-3 py-2 align-top">{children}</td>,
};

export function MarkdownPreview({ markdown }: { markdown: string }) {
  return (
    <div className="text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={ELEMENTS}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
