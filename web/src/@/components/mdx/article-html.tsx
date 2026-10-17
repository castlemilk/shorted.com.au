import type { AnchorHTMLAttributes, HTMLAttributes } from "react";
import { sectionTitle } from "~/@/lib/typography";
import { cn } from "~/@/lib/utils";
import { ArticleTable } from "./article-table";

type HeadingProps = HTMLAttributes<HTMLHeadingElement>;

function SectionHeading({ className, children, ...props }: HeadingProps) {
  return <h2 className={cn(sectionTitle, "text-foreground", className)} {...props}>{children}</h2>;
}

/** Shared HTML grammar for safe blog and newsroom MDX. Spacing is owned by
 * .article-prose, which excludes nested data figures and callouts. */
export const articleHtmlComponents = {
  h1: SectionHeading,
  h2: SectionHeading,
  h3: ({ className, children, ...props }: HeadingProps) => <h3 className={cn("font-mono text-xl font-semibold leading-snug text-foreground", className)} {...props}>{children}</h3>,
  h4: ({ className, children, ...props }: HeadingProps) => <h4 className={cn("font-mono text-lg font-semibold leading-snug text-foreground", className)} {...props}>{children}</h4>,
  h5: ({ className, children, ...props }: HeadingProps) => <h5 className={cn("font-mono text-base font-semibold text-foreground", className)} {...props}>{children}</h5>,
  h6: ({ className, children, ...props }: HeadingProps) => <h6 className={cn("font-mono text-base font-semibold text-foreground", className)} {...props}>{children}</h6>,
  a: ({ className, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => <a className={cn("text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary", className)} {...props}>{children}</a>,
  p: (props: HTMLAttributes<HTMLParagraphElement>) => <p {...props} />,
  ul: ({ className, ...props }: HTMLAttributes<HTMLUListElement>) => <ul className={cn("list-disc pl-6", className)} {...props} />,
  ol: ({ className, ...props }: HTMLAttributes<HTMLOListElement>) => <ol className={cn("list-decimal pl-6", className)} {...props} />,
  li: (props: HTMLAttributes<HTMLLIElement>) => <li {...props} />,
  blockquote: ({ className, ...props }: HTMLAttributes<HTMLQuoteElement>) => <blockquote className={cn("border-l border-primary/50 pl-5 text-muted-foreground", className)} {...props} />,
  table: ArticleTable,
  tr: ({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) => <tr className={cn("border-b border-border", className)} {...props} />,
  th: ({ className, ...props }: HTMLAttributes<HTMLTableCellElement>) => <th className={cn("px-4 py-3 text-left font-mono text-sm font-semibold", className)} {...props} />,
  td: ({ className, ...props }: HTMLAttributes<HTMLTableCellElement>) => <td className={cn("px-4 py-3 text-left font-mono text-sm tabular-nums", className)} {...props} />,
};
