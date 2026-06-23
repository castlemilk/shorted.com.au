import type { ReactNode } from "react";

/**
 * Editorial pull-quote. Newsreader serif, amber rule. `attribution` is the
 * speaker / source line; use <Cite> inside the body if a numbered ref is needed.
 */
export function PullQuote({
  children,
  attribution,
}: {
  children: ReactNode;
  attribution?: string;
}) {
  return (
    <figure className="my-12 border-l-2 border-primary/60 pl-6 sm:pl-8">
      <blockquote className="font-serif text-2xl font-light italic leading-snug text-foreground sm:text-3xl">
        {children}
      </blockquote>
      {attribution ? (
        <figcaption className="mt-4 font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
          {attribution}
        </figcaption>
      ) : null}
    </figure>
  );
}
