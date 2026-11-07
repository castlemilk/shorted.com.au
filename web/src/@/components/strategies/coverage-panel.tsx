import type {
  CoverageMonthView,
  CoverageYearView,
  DataQualityView,
  SurvivorshipView,
} from "@/lib/strategies/map-backtest";
import { CoverageStrip } from "@/components/strategies/coverage-strip";
import {
  coverageBars,
  coverageChip,
  coverageFigure,
  lowestCoverageYear,
} from "@/lib/strategies/backtest-tables";
import { COVERAGE_NOT_MEASURABLE_COPY, lowCoverageCopy } from "@/lib/strategies/backtest-copy";
import { NOT_AVAILABLE, formatCount } from "@/lib/strategies/format";
import { sectionTitle } from "@/lib/typography";

export interface CoveragePanelProps {
  years: readonly CoverageYearView[];
  months: readonly CoverageMonthView[];
  survivorship: SurvivorshipView | null;
  dataQuality: DataQualityView | null;
  dataNotes: readonly string[];
}

/** The survivorship line's words for each measurement the API states (8.2). */
export function survivorshipMeasureLabel(measurement: string): string {
  switch (measurement) {
    case "measured":
      return "Survivorship measured";
    case "partial":
      return "Survivorship partly measured";
    case "not_measurable":
      return "Survivorship not measurable";
    default:
      return "";
  }
}

/**
 * The coverage and survivorship block the Backtest tab's "Full recipe & data coverage"
 * link anchors to (1.5). Every coverage figure names its measure (5.11): qualifying (at
 * least 5% short, the strategy's own) or all reported. A measure that cannot be measured
 * for a year says "not measurable", never a number. The survivorship statement is the
 * run's own copy.
 */
export function CoveragePanel({ years, months, survivorship, dataQuality, dataNotes }: CoveragePanelProps) {
  const lowest = lowestCoverageYear(years);
  const anyUnmeasurable = years.some((year) => !year.measurable);
  const chip = coverageChip(years);
  return (
    <section id="coverage" aria-labelledby="coverage-heading" className="scroll-mt-[124px] space-y-6">
      <h2 id="coverage-heading" className={sectionTitle}>
        Coverage and survivorship
      </h2>

      {survivorship ? (
        <div className="space-y-2 rounded-md border border-border/60 p-4 text-sm" data-survivorship={survivorship.measurement}>
          {survivorshipMeasureLabel(survivorship.measurement) ? (
            <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
              {survivorshipMeasureLabel(survivorship.measurement)}
            </p>
          ) : null}
          <p>{survivorship.statement || NOT_AVAILABLE}</p>
          {survivorship.caveat ? <p className="text-muted-foreground">{survivorship.caveat}</p> : null}
        </div>
      ) : null}

      {chip ? <p className="text-sm" data-coverage-chip>{chip}</p> : null}

      {lowest ? (
        <p className="text-sm text-muted-foreground">{lowCoverageCopy(lowest.year, lowest.coveragePct ?? 0)}</p>
      ) : null}

      {years.length > 0 ? (
        <div className="space-y-3">
          <h3 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
            By year: each measure named
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-xs">
              <caption className="sr-only">Coverage by year under both measures, with the exits behind it</caption>
              <thead>
                <tr className="border-b border-border/60 text-left text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-3 font-normal">Year</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-normal">Qualifying (&ge; 5% short)</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-normal">All reported</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-normal">Priced name-days</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-normal">Delisting exits</th>
                  <th scope="col" className="py-1.5 text-right font-normal">CA exits</th>
                </tr>
              </thead>
              <tbody>
                {years.map((year) => (
                  <tr key={year.year} className="border-b border-border/40 font-mono tabular-nums">
                    <th scope="row" className="py-1.5 pr-3 text-left font-normal">{year.year}</th>
                    <td className="py-1.5 pr-3 text-right">{coverageFigure(year)}</td>
                    <td className="py-1.5 pr-3 text-right">
                      {year.allReportedPct === null ? "not measurable" : `${Math.round(year.allReportedPct)}%`}
                    </td>
                    <td className="py-1.5 pr-3 text-right">
                      {year.measurable ? `${formatCount(year.pricedNameDays)} of ${formatCount(year.qualifyingNameDays)}` : NOT_AVAILABLE}
                    </td>
                    <td className="py-1.5 pr-3 text-right">{year.delistingExits}</td>
                    <td className="py-1.5 text-right">{year.caExits}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="space-y-2">
            <p className="font-mono text-xs text-muted-foreground">Qualifying coverage by year</p>
            <CoverageStrip label="Qualifying coverage by year" items={coverageBars(years)} />
          </div>
          {anyUnmeasurable ? (
            <p className="text-xs text-muted-foreground" data-not-measurable>{COVERAGE_NOT_MEASURABLE_COPY}</p>
          ) : null}
        </div>
      ) : null}

      {months.length > 0 ? (
        <div className="space-y-2">
          <p className="font-mono text-xs text-muted-foreground">Monthly qualifying coverage: hatched under 80%</p>
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

      {dataQuality ? (
        <div className="space-y-2">
          <h3 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">Data-quality counts</h3>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
            <Count label="Delisting exits" value={dataQuality.delistingExits} />
            <Count label="Corporate-action exits" value={dataQuality.corporateActionExits} />
            <Count label="Corporate-action suspects" value={dataQuality.caSuspects} />
            <Count label="Held bars on a close fallback" value={dataQuality.fallbackClose} />
            <Count label="Trades on price return" value={dataQuality.priceReturnTrades} />
            <Count label="Capacity-capped trades" value={dataQuality.capacityCapped} />
            <Count label="Stale-mark trades" value={dataQuality.staleMarkTrades} />
            <Count label="Delayed exits" value={dataQuality.delayedExits} />
            <Count label="Ex-dates credited in cash" value={dataQuality.dividendsCredited} />
          </dl>
          {Object.keys(dataQuality.cancelledEntries).length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Entries cancelled:{" "}
              {Object.entries(dataQuality.cancelledEntries)
                .map(([reason, count]) => `${count} ${reason.replace(/_/g, " ")}`)
                .join(", ")}
            </p>
          ) : null}
          {dataQuality.consolidationNote ? (
            <p className="text-xs text-muted-foreground">{dataQuality.consolidationNote}</p>
          ) : null}
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

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border/40 py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  );
}
