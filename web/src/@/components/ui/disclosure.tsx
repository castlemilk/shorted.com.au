import { ChevronDown } from "lucide-react";

import { cn } from "~/@/lib/utils";

/**
 * Collapsible section built on native <details>/<summary>.
 *
 * WHY NATIVE, NOT A JS ACCORDION:
 *  - the body is server-rendered into the HTML, so crawlers and AI bots read
 *    the full text whether or not the panel is open (Google indexes
 *    accordion/tab content and, under mobile-first indexing, weights it
 *    normally). A `useState` accordion would render nothing until hydration;
 *  - zero client JS, so this costs nothing against the homepage bundle budget
 *    — see [[seo-embed-backlinks]]: `/` sits at its 185kB ceiling;
 *  - keyboard and screen-reader behaviour comes free, and it still works if
 *    hydration fails.
 *
 * This is a server component on purpose. Do not add onClick handlers.
 */
export interface DisclosureProps {
  /** Visible summary line. Pass a heading element to keep document outline. */
  title: React.ReactNode;
  /** Optional one-line hint shown next to the title when collapsed. */
  hint?: string;
  /** Start expanded. */
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}

export function Disclosure({
  title,
  hint,
  defaultOpen = false,
  className,
  children,
}: DisclosureProps) {
  return (
    <details
      open={defaultOpen}
      className={cn(
        "group border-b border-border/60 last:border-b-0",
        className,
      )}
    >
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center justify-between gap-3 py-3",
          "text-sm font-medium text-foreground transition-colors hover:text-primary",
          // Safari renders a disclosure triangle without this.
          "[&::-webkit-details-marker]:hidden",
        )}
      >
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          {title}
          {hint && (
            <span className="text-xs font-normal text-muted-foreground">
              {hint}
            </span>
          )}
        </span>
        <ChevronDown
          className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="pb-4 text-sm text-muted-foreground">{children}</div>
    </details>
  );
}

export default Disclosure;
