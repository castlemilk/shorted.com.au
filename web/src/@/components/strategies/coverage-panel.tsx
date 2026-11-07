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
  coverageMeasureName,
  coverageMeasureOf,
  lowestCoverageYear,
} from "@/lib/strategies/backtest-tables";
import { COVERAGE_NOT_MEASURABLE_COPY, lowCoverageCopy } from "@/lib/strategies/backtest-copy";
import { UNMEASURED_MARK, isUnmeasuredYear } from "@/lib/strategies/backtest-tables";

/** The explanation of "?" (1.7): its title, its accessible text and the legend line. */
export const UNMEASURED_COPY = COVERAGE_NOT_MEASURABLE_COPY;
import { NOT_AVAILABLE, formatCount } from "@/lib/strategies/format";
import { sectionTitle } from "@/lib/typography";

export interface CoveragePanelProps {
  years: readonly CoverageYearView[];
  months: readonly CoverageMonthView[];
  survivorship: SurvivorshipView | null;
  dataQuality: DataQualityView | null;
  dataNotes: readonly string[];
}

/** The survivorship line's heading, from the measurement (item 10): the copy names what the figures measure. */
export function coverageHeading(measurement: string): string {
  switch (measurement) {
    case "measured":
      return "Coverage measured · flatters results";
    case "partial":
      return "Coverage measured on ASIC-reported names only · flatters results";
    case "not_measurable":
      return "Coverage not measurable · flatters results";
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
  const measure = coverageMeasureOf(survivorship?.measurement);
  const lowest = lowestCoverageYear(years, measure);
  const hasMark = years.some((year) => isUnmeasuredYear(year, measure));
  const chip = coverageChip(years, measure);
  return (
    <section id="coverage" aria-labelledby="coverage-heading" className="scroll-mt-[124px] space-y-6">
      <h2 id="coverage-heading" className={sectionTitle}>
        Coverage and survivorship
      </h2>

      {survivorship ? (
        <div className="space-y-2 rounded-md border border-border/60 p-4 text-sm" data-survivorship={survivorship.measurement}>
          {coverageHeading(survivorship.measurement) ? (
            <p className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
              {coverageHeading(survivorship.measurement)}
            </p>
          ) : null}
          <p>{survivorship.statement || NOT_AVAILABLE}</p>
          {survivorship.caveat ? <p className="text-muted-foreground">{survivorship.caveat}</p> : null}
        </div>
      ) : null}

      {chip ? <p className="text-sm" data-coverage-chip>{chip}</p> : null}

      {lowest ? (
        lowest.coveragePct < 80 ? (
          <p className="text-sm text-muted-foreground" data-lowest-coverage>
            {lowCoverageCopy(lowest.year, lowest.coveragePct)} ({coverageMeasureName(measure)}.)
          </p>
        ) : null
      ) : null}

      {years.length > 0 ? (
        <div className="space-y-3">
          <h3 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
            By year: each measure named
          </h3>
          <div
            role="region"
            aria-label="Coverage by year"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- A scroll region needs focus for arrow-key scrolling.
            tabIndex={0} className="overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
            <table className="w-full min-w-[560px] border-collapse text-xs">
              <caption className="sr-only">Coverage by year under both measures, with the exits behind it</caption>
              <thead>
                <tr className="border-b border-border/60 text-left text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-3 font-normal">Year</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-normal">{measure === "qualifying" ? "Qualifying (≥ 5% short), the run's measure" : "Qualifying (≥ 5% short)"}</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-normal">{measure === "all_reported" ? "All reported, the run's measure" : "All reported"}</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-normal">Priced name-days</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-normal">Delisting exits</th>
                  <th scope="col" className="py-1.5 text-right font-normal">CA exits</th>
                </tr>
              </thead>
              <tbody>
                {years.map((year) => (
                  <tr key={year.year} className="border-b border-border/40 font-mono tabular-nums">
                    <th scope="row" className="py-1.5 pr-3 text-left font-normal">{year.year}</th>
                    <td className="py-1.5 pr-3 text-right">
                      {isUnmeasuredYear(year, measure) ? (
                        <span title={UNMEASURED_COPY} data-unmeasured="">
                          {coverageFigure(year, measure)}
                          <span className="sr-only"> ({UNMEASURED_COPY})</span>
                        </span>
                      ) : (
                        coverageFigure(year, measure)
                      )}
                    </td>
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
            <CoverageStrip
              label={`${coverageMeasureName(measure)} coverage by year`}
              items={coverageBars(years, measure).map((bar) => ({ ...bar, markTitle: bar.mark ? UNMEASURED_COPY : undefined }))}
            />
          </div>
          {hasMark ? (
            <p className="text-xs text-muted-foreground" data-unmeasured-legend>
              <span aria-hidden="true" className="font-mono">{UNMEASURED_MARK}</span> {UNMEASURED_COPY}
            </p>
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
