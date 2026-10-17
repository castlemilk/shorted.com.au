import {
  NOT_AVAILABLE,
  NOT_MEANINGFUL,
  basisDescription,
  basisLabel,
  formatGrowthPct,
  type BasisLabel,
} from "~/@/lib/fundamentals/format";
import type { StockFundamentalsGrowth } from "~/app/actions/getStockFundamentals";
import { ProvenanceMark } from "./provenance";

// The growth row of the Latest result card (docs/plans/fundamentals-coverage.md
// §7.1, item 1): the SAME labels and figures as the picker's growth cells.
// Both surfaces read one vocabulary (lib/fundamentals/format.ts): the figure
// is formatGrowthPct (n/m with the raw figure in the title outside +500% /
// -95%), the basis tag is basisLabel (TTM / FY / HY), its title is
// basisDescription, and a figure computed from a company filing carries the
// filing mark. Props-only and hook-free.

/** The picker's column labels, verbatim. */
export const REVENUE_GROWTH_LABEL = "Rev YoY";
export const EPS_GROWTH_LABEL = "EPS YoY";

const FILING_SOURCE = "asx-filing-extraction";

export interface GrowthFigure {
  label: string;
  /** "+12.3%", "n/m" or "n/a". */
  text: string;
  /** "TTM" | "FY" | "HY" | "". */
  basis: BasisLabel;
  /** Tooltip: the basis period, and the raw figure behind an "n/m". */
  title: string;
  /** The pair behind the figure includes a company-filing value. */
  fromFiling: boolean;
}

function joinTitle(...parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(". ");
}

/**
 * The two growth figures exactly as the picker cells state them. An API that
 * predates revenue_basis_period_type only ever computed revenue annual on
 * annual, so an empty revenue basis reads FY.
 */
export function growthFigures(growth: StockFundamentalsGrowth): GrowthFigure[] {
  const revenueBasis = growth.revenueBasisPeriodType || "annual";
  const revenue = formatGrowthPct(growth.revenueYoyPct);
  const eps = formatGrowthPct(growth.epsYoyPct);
  return [
    {
      label: REVENUE_GROWTH_LABEL,
      text: revenue.text,
      basis: basisLabel(revenueBasis),
      // The revenue pair's own end; never borrowed from the EPS series.
      title: joinTitle(
        basisDescription(revenueBasis, growth.revenueLatestPeriodEnd),
        revenue.title,
      ),
      fromFiling: growth.revenueBasisSource === "filing",
    },
    {
      label: EPS_GROWTH_LABEL,
      text: eps.text,
      basis: basisLabel(growth.basisPeriodType),
      title: joinTitle(
        basisDescription(growth.basisPeriodType, growth.latestPeriodEnd),
        eps.title,
      ),
      fromFiling: growth.epsBasisSource === "filing",
    },
  ];
}

/** One growth figure: label, value, basis tag and the filing mark. */
export function GrowthFigureView({ figure }: { figure: GrowthFigure }) {
  const muted = figure.text === NOT_AVAILABLE || figure.text === NOT_MEANINGFUL;
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
        {figure.label}
      </dt>
      <dd
        className="mt-1 flex items-baseline gap-1.5 font-mono tabular-nums"
        title={figure.title || undefined}
      >
        <span className={muted ? "text-muted-foreground" : "text-foreground"}>
          {figure.text}
        </span>
        {figure.basis ? (
          <span className="text-[11px] text-muted-foreground">{figure.basis}</span>
        ) : null}
        {figure.fromFiling ? <ProvenanceMark source={FILING_SOURCE} /> : null}
      </dd>
    </div>
  );
}
