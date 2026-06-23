import { SOURCES, SOURCES_BY_GROUP } from "./data/sources";

/**
 * Bibliography + method note. Each entry carries `id="source-<id>"` so inline
 * <Cite> superscripts and chart-frame source links scroll to it.
 */
export function SourcesList() {
  return (
    <section id="sources" className="mt-24 scroll-mt-24 border-t border-border pt-10">
      <h2 className="font-serif text-2xl text-foreground sm:text-3xl">Sources &amp; method</h2>
      <p className="mt-4 max-w-prose text-sm leading-relaxed text-muted-foreground">
        Every figure is drawn from primary sources — ASIC, the RBA, ABS, ATO,
        APRA, Treasury, the BIS and OECD. Cross-country house-price indices are
        BIS &ldquo;real residential property prices&rdquo; (inflation-adjusted,
        2010&nbsp;=&nbsp;100), reduced to annual averages so the four markets sit
        on one comparable basis. Short-position figures are live ASIC data via
        Shorted. Figures marked <em>derived</em> or <em>illustrative</em> in a
        chart are estimates and are flagged there. Nothing here is financial
        advice.
      </p>
      <div className="mt-8 space-y-7">
        {SOURCES_BY_GROUP.map(({ group, label }) => {
          const items = SOURCES.filter((s) => s.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group}>
              <h3 className="font-mono text-xs uppercase tracking-[0.2em] text-primary">
                {label}
              </h3>
              <ol className="mt-3 space-y-2">
                {items.map((s) => (
                  <li
                    key={s.id}
                    id={`source-${s.id}`}
                    className="scroll-mt-24 text-sm leading-relaxed text-muted-foreground"
                  >
                    <span className="mr-2 font-mono text-xs text-primary">[{s.n}]</span>
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-foreground/90 underline-offset-2 hover:text-primary hover:underline"
                    >
                      {s.title}
                    </a>
                    <span className="text-muted-foreground"> — {s.publisher} ({s.year})</span>
                  </li>
                ))}
              </ol>
            </div>
          );
        })}
      </div>
    </section>
  );
}
