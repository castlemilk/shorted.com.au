import type { RecipeLinesView } from "@/lib/strategies/map-backtest";
import { RECIPE_PREFACE_FALLBACK } from "@/lib/strategies/backtest-copy";

export interface AssumptionsListProps {
  recipe: RecipeLinesView;
}

/**
 * The execution assumptions, generated from the recipe (5.2, 5.3), one labelled
 * line each in print order. The preface opens the list: the recipe is Shorted's
 * test of the screen, not the author's own entries and exits (5.3).
 */
export function AssumptionsList({ recipe }: AssumptionsListProps) {
  const rows: Array<{ key: string; label: string; text: string | string[] }> = [
    { key: "entry", label: "Entry", text: recipe.entry },
    { key: "exits", label: "Exits", text: recipe.exits },
    { key: "positions", label: "Positions", text: recipe.sizing },
    { key: "brokerage", label: "Brokerage", text: recipe.brokerage },
    { key: "spread", label: "Spread", text: recipe.spread },
    { key: "capacity", label: "Capacity", text: recipe.capacity },
    { key: "dividends", label: "Dividends", text: recipe.dividends },
    { key: "asic", label: "ASIC data", text: recipe.asicData },
    { key: "delisting", label: "Delisting", text: recipe.delisting },
    { key: "capital", label: "Capital", text: recipe.capital || "Starting capital A$100,000." },
    { key: "cash", label: "Cash", text: recipe.cash },
  ];
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">{recipe.preface || RECIPE_PREFACE_FALLBACK}</p>
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
        {rows
          .filter((row) => (Array.isArray(row.text) ? row.text.length > 0 : row.text !== ""))
          .map((row) => (
            <div key={row.key} className="contents">
              <dt className="font-mono text-muted-foreground">{row.label}</dt>
              <dd className="leading-snug">
                {Array.isArray(row.text) ? (
                  <ul className="space-y-1">
                    {row.text.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : (
                  row.text
                )}
              </dd>
            </div>
          ))}
      </dl>
    </div>
  );
}
