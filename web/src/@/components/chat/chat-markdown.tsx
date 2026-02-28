"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ChatMarkdownProps {
  content: string;
}

export function ChatMarkdown({ content }: ChatMarkdownProps) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        table: ({ children, ...props }) => (
          <div className="overflow-x-auto my-2">
            <table
              className="min-w-full text-xs border-collapse"
              {...props}
            >
              {children}
            </table>
          </div>
        ),
        th: ({ children, ...props }) => (
          <th
            className="border border-border px-2 py-1 bg-muted font-medium text-left"
            {...props}
          >
            {children}
          </th>
        ),
        td: ({ children, ...props }) => (
          <td className="border border-border px-2 py-1" {...props}>
            {children}
          </td>
        ),
        a: ({ children, href, ...props }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-2"
            {...props}
          >
            {children}
          </a>
        ),
        code: ({ children, className, ...props }) => {
          const isInline = !className;
          if (isInline) {
            return (
              <code
                className="bg-muted rounded px-1 py-0.5 text-xs font-mono"
                {...props}
              >
                {children}
              </code>
            );
          }
          return (
            <code
              className="block bg-muted rounded p-2 text-xs font-mono overflow-x-auto"
              {...props}
            >
              {children}
            </code>
          );
        },
        ul: ({ children, ...props }) => (
          <ul className="list-disc pl-4 my-1 space-y-0.5" {...props}>
            {children}
          </ul>
        ),
        ol: ({ children, ...props }) => (
          <ol className="list-decimal pl-4 my-1 space-y-0.5" {...props}>
            {children}
          </ol>
        ),
        p: ({ children, ...props }) => (
          <p className="my-1.5 leading-relaxed" {...props}>
            {children}
          </p>
        ),
        h1: ({ children, ...props }) => (
          <h1 className="text-base font-bold mt-3 mb-1" {...props}>
            {children}
          </h1>
        ),
        h2: ({ children, ...props }) => (
          <h2 className="text-sm font-bold mt-2.5 mb-1" {...props}>
            {children}
          </h2>
        ),
        h3: ({ children, ...props }) => (
          <h3 className="text-sm font-semibold mt-2 mb-0.5" {...props}>
            {children}
          </h3>
        ),
        blockquote: ({ children, ...props }) => (
          <blockquote
            className="border-l-2 border-border pl-3 my-2 text-muted-foreground italic"
            {...props}
          >
            {children}
          </blockquote>
        ),
        hr: (props) => <hr className="my-3 border-border" {...props} />,
      }}
    >
      {content}
    </ReactMarkdown>
    </div>
  );
}
