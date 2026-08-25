import Link from "next/link";

import { cn } from "~/@/lib/utils";
import { themesForIndustry, themesForTicker } from "~/@/lib/themes/registry";

/**
 * "Part of: <theme>" chips for a stock page.
 *
 * A plain server component — the theme registry is static data, so this costs
 * no fetch and ships in the ISR HTML where crawlers see it. Renders nothing
 * for the ~4,400 codes that belong to no curated basket.
 */
export function StockThemeChips({
  stockCode,
  className,
}: {
  stockCode: string;
  className?: string;
}) {
  const themes = themesForTicker(stockCode);
  if (themes.length === 0) return null;

  return (
    <nav
      aria-label={`${stockCode.toUpperCase()} themes`}
      className={cn("flex flex-wrap items-center gap-x-2 gap-y-1.5", className)}
    >
      <span className="text-xs text-muted-foreground">Part of</span>
      {themes.map((theme) => (
        <Link
          key={theme.slug}
          href={`/themes/${theme.slug}`}
          prefetch={false}
          className="rounded-full border border-border/60 bg-card/50 px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
        >
          {theme.name}
        </Link>
      ))}
    </nav>
  );
}

/**
 * "Related themes" block for an industry surface. Matches on the registry's
 * relatedIndustries, which hold exact mv_screener_data.industry strings.
 */
export function RelatedThemesForIndustry({
  industry,
  className,
}: {
  industry: string;
  className?: string;
}) {
  const matches = themesForIndustry(industry);
  if (matches.length === 0) return null;

  return (
    <nav
      aria-label="Related themes"
      className={cn(
        "rounded-lg border border-border/60 bg-card/50 px-4 py-3",
        className,
      )}
    >
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Related themes
      </p>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
        {matches.map((theme) => (
          <li key={theme.slug}>
            <Link
              href={`/themes/${theme.slug}`}
              prefetch={false}
              className="text-primary hover:underline"
            >
              {theme.h1}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
