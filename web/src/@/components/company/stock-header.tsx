import { Suspense } from "react";
import { Sparkles } from "lucide-react";
import { getStockDetails } from "~/app/actions/getStockDetails";
import { Badge } from "~/@/components/ui/badge";
import { CompanyLogo } from "~/@/components/ui/company-logo";
import { Skeleton } from "~/@/components/ui/skeleton";
import { cleanCompanyName } from "~/@/lib/company-name";
import { industryLabel } from "~/@/lib/industry-placeholder";
import { formatAsOfDate } from "~/@/lib/stocks/as-of-date";
import { shortPercentFigure } from "~/@/lib/stocks/short-percent";
import { formatNumber } from "~/@/lib/utils";
import { type Stock, type StockDetails } from "~/gen/stocks/v1alpha1/stocks_pb";

// One header per page, so one id is enough for the section's accessible name.
const NAME_ID = "stock-header-name";

// U+2212, the sign of a fall (DESIGN.md, the Tabular Rule), and U+2013, the
// glyph for no change. Written as escapes because both look like a hyphen.
const MINUS = "\u2212";
const FLAT = "\u2013";

// The 30-day change in signal red and green (DESIGN.md, the Semantic
// Quarantine Rule: the direction of a number). A rise is more of the register
// betting against the stock, so it is red; a fall is green, as the industry
// panel colours the same change. No change stays in the foreground. The light
// shades are a step darker than the dark ones, for contrast at 11px on white.
const CHANGE_TONE = {
  up: "text-red-600 dark:text-red-400",
  down: "text-green-700 dark:text-green-400",
  flat: "text-foreground",
} as const;

// What the logo needs of the company details, for when there are none.
const NO_DETAILS: Pick<
  StockDetails,
  "companyName" | "gcsUrl" | "logoIconGcsUrl" | "enrichmentStatus"
> = { companyName: "", gcsUrl: "", logoIconGcsUrl: "", enrichmentStatus: "" };

const LABEL =
  "font-mono text-[10px] uppercase leading-3 text-muted-foreground";

// The secondary figures. Their line box matches the short percentage's (24px)
// from `sm`, where the three sit side by side and their baselines should agree.
const FIGURE =
  "font-mono text-sm font-medium leading-4 tabular-nums sm:text-base sm:leading-6";

export interface StockHeaderProps {
  stockCode: string;
  stock: Stock;
  /** Change in the short percentage over 30 days, in percentage points. Null when unknown. */
  change30d: number | null;
  /** The ASIC report date the figures are as of. Null when unknown. */
  asOf: Date | null;
}

/**
 * The compact header that opens every tab of /shorts/[stockCode]: who the
 * company is on the left, what its short position is on the right (below `sm`
 * the identity sits above the readout).
 *
 * A server component with no client retry twin. Its only client child is
 * CompanyLogo, so nothing here puts Connect-RPC in a client bundle. Keep it
 * free of "use client" and of any @connectrpc/connect import of its own.
 *
 * A missing value is left out, never stood in for by "undefined", a
 * placeholder dash or a zero. The API sends a figure it does not hold as 0 (a
 * proto3 number has no unset), so "Shares on issue" is drawn only when it is
 * above 0, and "Reported shorts" only when it is above 0 or the short
 * percentage is itself 0, a true zero.
 */
export function StockHeader({
  stockCode,
  stock,
  change30d,
  asOf,
}: StockHeaderProps) {
  // The backend title-caser mangles ticker acronyms ("BHP GROUP LIMITED" would
  // read "Bhp Group"); repair at display time. See lib/company-name.ts.
  const name = cleanCompanyName(stock.name || stockCode, stockCode);
  // The ASX's "Not Applic" of an ETF or a trust is a placeholder, not an
  // industry: it gets no badge, as an empty one does not.
  const industry = industryLabel(stock.industry);
  const sharesOnIssue = stock.totalProductInIssue ?? 0;
  const reportedShorts = stock.reportedShortPositions ?? 0;
  const showSharesOnIssue = sharesOnIssue > 0;
  const showReportedShorts = reportedShorts > 0 || stock.percentageShorted === 0;
  const change =
    change30d !== null && Number.isFinite(change30d)
      ? describeChange(change30d)
      : null;

  return (
    // The One Bloom Rule (DESIGN.md §4): this is the single lit surface on
    // /shorts/[stockCode]. It carries the readout the visitor actually came
    // for, the short position, so it gets `terminal-inset`, the vocabulary's
    // "inner phosphor bloom for terminal-style panels". Everything else on
    // the page is flat: the chart is deliberately unframed, and Card no
    // longer ships a resting shadow. Squint at the view and exactly one
    // thing is bright. Do not add a second.
    <section
      aria-labelledby={NAME_ID}
      className="mb-4 flex flex-col gap-1.5 rounded-lg border bg-card px-4 py-3 shadow-terminal-inset sm:flex-row sm:items-center sm:justify-between sm:gap-6"
    >
      <div className="flex min-w-0 items-center gap-3 sm:flex-1">
        {/* A fixed box, so the logo arriving (or failing) cannot move the
            header. The fallback fills the same box. */}
        <div className="relative h-10 w-10 shrink-0 sm:h-12 sm:w-12">
          <Suspense
            fallback={<Skeleton aria-hidden="true" className="h-full w-full" />}
          >
            <StockHeaderLogo stockCode={stockCode} />
          </Suspense>
        </div>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 font-mono text-sm font-semibold leading-4">
              {stockCode}
            </span>
            {industry ? (
              <Badge
                variant="outline"
                title={industry}
                className="min-w-0 py-0 text-[10px] leading-4"
              >
                <span className="truncate">{industry}</span>
              </Badge>
            ) : null}
          </div>
          {/* h2: the page's h1 is the sr-only crawler summary in page.tsx */}
          <h2
            id={NAME_ID}
            title={name}
            className="font-mono text-lg font-bold leading-tight line-clamp-2 sm:line-clamp-1 sm:text-xl"
          >
            {name}
          </h2>
        </div>
      </div>

      <dl className="grid grid-cols-[auto_auto] justify-between gap-x-4 gap-y-1.5 sm:flex sm:shrink-0 sm:items-start sm:justify-start sm:gap-x-6">
        {/* Below `sm` this block spans both rows of the left column and the
            other two (when the API holds them) stack in the right one. From
            `sm` they are columns. */}
        <div className="row-span-2">
          <dt className={LABEL}>Short interest</dt>
          <dd className="font-mono text-2xl font-bold leading-none tabular-nums">
            {/* "<0.01%" for a position too small to state; "0.00%" only for
                a true zero (an absent field is one: protojson drops a zero). */}
            {shortPercentFigure(stock.percentageShorted) ?? "0.00%"}
          </dd>
          {change ? (
            <dd
              title="Change in short interest over the last 30 days, in percentage points"
              className={`font-mono text-[11px] leading-[13px] tabular-nums ${CHANGE_TONE[change.tone]}`}
            >
              {/* The sign says which way it went; the arrow only shows it. */}
              <span aria-hidden="true">{change.arrow}</span> {change.text} 30d
            </dd>
          ) : null}
          {asOf ? (
            <dd
              title="ASIC short position report date (published T+4)"
              className="font-mono text-[10px] leading-3 text-muted-foreground"
            >
              as of {formatAsOfDate(asOf)}
            </dd>
          ) : null}
        </div>

        {showReportedShorts ? (
          <div>
            <dt className={LABEL}>Reported shorts</dt>
            <dd className={FIGURE}>{formatNumber(reportedShorts)}</dd>
          </div>
        ) : null}

        {showSharesOnIssue ? (
          <div>
            <dt className={LABEL}>Shares on issue</dt>
            <dd className={FIGURE}>{formatNumber(sharesOnIssue, 3)}</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

/**
 * The logo, read from the company details (cached) inside the header's
 * Suspense boundary. The details read never holds the header: it fills the
 * fixed box when it lands.
 *
 * A null or failed read still draws CompanyLogo, which finds the logo by code
 * and falls back to its own icon, so the box is never empty.
 */
export async function StockHeaderLogo({ stockCode }: { stockCode: string }) {
  let details: StockDetails | null | undefined;
  try {
    details = await getStockDetails(stockCode);
  } catch {
    details = null;
  }
  const { companyName, gcsUrl, logoIconGcsUrl, enrichmentStatus } =
    details ?? NO_DETAILS;

  return (
    <>
      {/* CompanyLogo sizes its image with an inline style, so the box can only
          win with !important; the icon it falls back to carries width and
          height attributes, which any rule beats. An empty name or url is
          left out, so CompanyLogo falls back to the code. */}
      <CompanyLogo
        stockCode={stockCode}
        companyName={companyName || undefined}
        gcsUrl={logoIconGcsUrl || gcsUrl || undefined}
        size={48}
        className="flex h-full w-full items-center justify-center [&_svg]:h-full [&_svg]:w-full"
        imageClassName="!h-full !w-full object-contain"
      />
      {enrichmentStatus === "completed" ? (
        <span
          role="img"
          aria-label="AI-enhanced data available"
          title="AI-enhanced data available"
          className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-card text-primary"
        >
          <Sparkles className="h-3 w-3" aria-hidden="true" />
        </span>
      ) : null}
    </>
  );
}

/**
 * The 30-day change as the header prints it: a direction glyph, a signed
 * magnitude and the tone it is coloured by. Round first, so the glyph, the
 * sign, the digits and the colour always agree ("0.004" is flat, not a red
 * "▲ +0.00"), and a true minus signs a fall.
 */
function describeChange(change: number): {
  arrow: string;
  text: string;
  tone: keyof typeof CHANGE_TONE;
} {
  const rounded = Number(change.toFixed(2)) || 0; // `|| 0` turns -0 into 0
  if (rounded === 0) return { arrow: FLAT, text: "0.00 pp", tone: "flat" };
  const sign = rounded > 0 ? "+" : MINUS;
  return {
    arrow: rounded > 0 ? "▲" : "▼",
    text: `${sign}${Math.abs(rounded).toFixed(2)} pp`,
    tone: rounded > 0 ? "up" : "down",
  };
}
