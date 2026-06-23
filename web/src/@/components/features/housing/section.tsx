import type { ReactNode } from "react";

/**
 * A numbered article section header (kicker + Newsreader title) followed by its
 * body. Lives inside the article column; charts/stat-strips sit among the body.
 */
export function Section({
  id,
  numeral,
  kicker,
  title,
  children,
}: {
  id?: string;
  numeral: string;
  kicker?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="mt-20 scroll-mt-24">
      <header className="mb-7">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-sm font-semibold text-primary">{numeral}</span>
          {kicker ? (
            <span className="font-mono text-[0.7rem] uppercase tracking-[0.25em] text-muted-foreground">
              {kicker}
            </span>
          ) : null}
        </div>
        <h2 className="mt-3 font-serif text-3xl leading-[1.1] text-foreground sm:text-[2.5rem]">
          {title}
        </h2>
      </header>
      {children}
    </section>
  );
}
