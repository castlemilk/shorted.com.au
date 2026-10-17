import Link from "next/link";

import { cn } from "~/@/lib/utils";
import { STRATEGIES, STRATEGY_SLUGS } from "~/@/lib/strategies/registry";
import { StrategyGlyph } from "./strategy-glyph";

/**
 * A row of links, one per strategy, each with its glyph and the current one
 * lit. Links rather than tabs on purpose: every strategy is its own
 * indexable URL with its own title and H1, and switching is a navigation,
 * not client state. The glyph is decorative; the label is the name.
 */
export function StrategySwitcher({ current }: { current: string }) {
  return (
    <nav aria-label="Strategies">
      <ul className="flex flex-wrap gap-2">
        {STRATEGY_SLUGS.map((slug) => {
          const strategy = STRATEGIES[slug]!;
          const active = slug === current;
          return (
            <li key={slug}>
              <Link
                href={`/picks/${slug}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex h-9 items-center gap-2 rounded-md border px-3 text-xs transition-colors duration-150 motion-reduce:transition-none",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  active
                    ? "border-primary/60 bg-primary/10 font-semibold text-primary"
                    : "border-border text-muted-foreground hover:border-input hover:text-foreground",
                )}
              >
                <StrategyGlyph slug={slug} className="h-5 w-5" />
                {strategy.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
