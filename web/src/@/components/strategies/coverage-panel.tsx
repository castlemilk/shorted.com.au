import type {
  CoverageMonthView,
  CoverageYearView,
  SurvivorshipView,
} from "@/lib/strategies/map-backtest";
import { CoverageStrip } from "@/components/strategies/coverage-strip";
import { coverageBars, coverageFigure, lowestCoverageYear } from "@/lib/strategies/backtest-tables";
import { COVERAGE_NOT_MEASURABLE_COPY, lowCoverageCopy } from "@/lib/strategies/backtest-copy";
import { NOT_AVAILABLE } from "@/lib/strategies/format";
import { sectionTitle } from "@/lib/typography";

export interface CoveragePanelProps {
  years: readonly CoverageYearView[];
  months: readonly CoverageMonthView[];
  survivorship: SurvivorshipView | null;
  dataNotes: readonly string[];
}

/**
 * The coverage and survivorship block the Backtest tab's "Full recipe & data
 * coverage" link anchors to (1.5). Every coverage figure names its measure
 * (5.11): "qualifying >= 5% short" (the strategy's own) or "all reported". A
 * year that is not measurable says so, and the survivorship statement is the
 * server's copy, not ours.
 */
export function CoveragePanel({ years, months, survivorship, dataNotes }: CoveragePanelProps) {
  const lowest = lowestCoverageYear(years);
  return (
    <section id="coverage" aria-labelledby="coverage-heading" className="scroll-mt-[124px] space-y-6">
      <h2 id="coverage-heading" className={sectionTitle}>
        Coverage and survivorship
      </h2>

      {survivorship ? (
        <div className="space-y-2 rounded-md border border-border/60 p-4 text-sm" data-survivorship={survivorship.measurement}>
          <p>{survivorship.statement || NOT_AVAILABLE}</p>
          {survivorship.caveat ? <p className="text-muted-foreground">{survivorship.caveat}</p> : null}
        </div>
      ) : null}

      {lowest ? (
        <p className="text-sm text-muted-foreground">
          {lowCoverageCopy(lowest.year, lowest.coveragePct ?? 0)}
        </p>
      ) : null}

      {years.length > 0 ? (
        <div className="space-y-3">
          <h3 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
            By year: two measures, each named
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-xs">
              <caption className="sr-only">Coverage by year under both measures, and the data-quality counts behind it</caption>
              <thead>
                <tr className="border-b border-border/60 text-left text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-3 font-normal">Year</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-normal">Qualifying (&ge; 5% short)</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-normal">All reported</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-normal">Priced name-days</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-normal">Delisting exits</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-normal">CA exits</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-normal">Flat-bar cancels</th>
                  <th scope="col" className="py-1.5 text-right font-normal">Dividend-step suspects</th>
                </tr>
              </thead>
              <tbody>
                {years.map((year) => (
                  <tr key={year.year} className="border-b border-border/40 font-mono tabular-nums">
                    <th scope="row" className="py-1.5 pr-3 text-left font-normal">{year.year}</th>
                    <td className="py-1.5 pr-3 text-right">{coverageFigure(year)}</td>
                    <td className="py-1.5 pr-3 text-right">
                      {year.allReportedPct === null ? NOT_AVAILABLE : `${Math.round(year.allReportedPct)}%`}
                    </td>
                    <td className="py-1.5 pr-3 text-right">
                      {year.pricedNameDays} of {year.qualifyingNameDays}
                    </td>
                    <td className="py-1.5 pr-3 text-right">{year.dataQuality.delistingExits}</td>
                    <td className="py-1.5 pr-3 text-right">{year.dataQuality.caExits}</td>
                    <td className="py-1.5 pr-3 text-right">{year.dataQuality.flatBarCancels}</td>
                    <td className="py-1.5 text-right">{year.dataQuality.dividendStepSuspects}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="space-y-2">
            <p className="font-mono text-xs text-muted-foreground">Qualifying coverage by year</p>
            <CoverageStrip label="Qualifying coverage by year" items={coverageBars(years)} />
          </div>
          {years.some((year) => !year.measurable) ? (
            <p className="text-xs text-muted-foreground">{COVERAGE_NOT_MEASURABLE_COPY}</p>
          ) : null}
        </div>
      ) : null}

      {months.length > 0 ? (
        <div className="space-y-2">
          <p className="font-mono text-xs text-muted-foreground">Monthly coverage: hatched under 80%</p>
          <CoverageStrip
            label="Monthly qualifying coverage"
            layout="columns"
            items={months.map((m) => ({
              key: m.month,
              label: m.month,
              coverage: m.measurable && m.coveragePct !== null ? m.coveragePct / 100 : null,
            }))}
          />
        </div>
      ) : null}

      {dataNotes.length > 0 ? (
        <div className="space-y-2">
          <h3 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">Data notes</h3>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {dataNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
