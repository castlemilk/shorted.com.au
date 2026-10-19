/* eslint-disable @next/next/no-img-element, jsx-a11y/alt-text */
import { seriesColor } from "~/@/components/charts/chart-theme";
import type { ChartViewId } from "~/@/components/charts/chart-views";
import { OG, OgLogoChip, type CompanyLogo } from "./card";
import {
  buildChartGeometry,
  formatDate,
  formatPrice,
  formatPriceChange,
  formatShort,
  formatShortChange,
  seriesChange,
  type ChartGeometry,
  type SeriesPoint,
} from "./chart-image";

/**
 * The shareable chart card (`/chart/[code]/image`): the stock's chart, drawn
 * as inline SVG paths, under its code, company and latest readings.
 *
 * Sized for where it is seen. Discord and Slack show an og:image about 400px
 * wide, a third of this canvas, so every figure a reader needs (the code, the
 * latest short interest and price, the dates) is at least 20px here and the
 * headline figures 50px and up. Axis labels are divs over the plot, not SVG
 * <text>: satori draws SVG through resvg, which has no fonts of its own.
 */

const W = 1200;
const PAD_X = 56;
const AXIS_W = 104;
const AXIS_GAP = 14;
const PLOT_TOP = 226;
const PLOT_H = 286;
const PLOT_LEFT = PAD_X + AXIS_W;

const PRICE = seriesColor("price");
const SHORT = seriesColor("short");
const UP = OG.green;
const DOWN = OG.red;

export interface OgChartCardProps {
  code: string;
  /** Cleaned company name; omitted when unknown. */
  company?: string;
  view: ChartViewId;
  /** "Share price and short interest", capitalised. */
  subject: string;
  /** "past month", "all available history". */
  periodPhrase: string;
  /** Data provenance, e.g. "ASIC short position reports". */
  source: string;
  short: SeriesPoint[];
  price: SeriesPoint[];
  logoSrc: string;
  brand?: CompanyLogo;
}

function Readout({
  color,
  label,
  value,
  change,
  changeColor,
}: {
  color: string;
  label: string;
  value: string;
  change: string | null;
  changeColor: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            display: "flex",
            width: 22,
            height: 5,
            borderRadius: 3,
            backgroundColor: color,
          }}
        />
        <div
          style={{
            display: "flex",
            fontSize: 19,
            letterSpacing: 2,
            textTransform: "uppercase",
            color: OG.textDim,
          }}
        >
          {label}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          marginTop: 4,
          fontSize: 56,
          fontWeight: 700,
          color: OG.text,
          lineHeight: 1.1,
        }}
      >
        {value}
      </div>
      {change && (
        <div
          style={{
            display: "flex",
            marginTop: 2,
            fontSize: 24,
            color: changeColor,
          }}
        >
          {change}
        </div>
      )}
    </div>
  );
}

function PlotSvg({ geometry }: { geometry: ChartGeometry }) {
  const { width, height } = geometry;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <defs>
        <linearGradient id="fill-price" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={PRICE} stopOpacity={0.38} />
          <stop offset="100%" stopColor={PRICE} stopOpacity={0.03} />
        </linearGradient>
        <linearGradient id="fill-short" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={SHORT} stopOpacity={0.38} />
          <stop offset="100%" stopColor={SHORT} stopOpacity={0.03} />
        </linearGradient>
      </defs>
      {geometry.leftTicks.map((t) => (
        <line
          key={`grid-${t.y}`}
          x1={0}
          x2={width}
          y1={t.y}
          y2={t.y}
          stroke={OG.border}
          strokeWidth={1.5}
          strokeDasharray="5 7"
        />
      ))}
      {geometry.series.map((s) =>
        s.area ? (
          <path
            key={`area-${s.role}`}
            d={s.area}
            fill={`url(#fill-${s.role})`}
          />
        ) : null,
      )}
      {geometry.series.map((s) => (
        <path
          key={`line-${s.role}`}
          d={s.line}
          fill="none"
          stroke={s.role === "price" ? PRICE : SHORT}
          strokeWidth={4}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
      {geometry.series.map((s) => (
        <circle
          key={`last-${s.role}`}
          cx={s.last.x}
          cy={s.last.y}
          r={8}
          fill={s.role === "price" ? PRICE : SHORT}
          stroke={OG.bg}
          strokeWidth={3}
        />
      ))}
    </svg>
  );
}

const LABEL_H = 26;
const DATE_W = 220;

function AxisLabels({
  geometry,
  plotRight,
}: {
  geometry: ChartGeometry;
  plotRight: number;
}) {
  const label = (
    key: string,
    top: number,
    style: Record<string, unknown>,
    text: string,
  ) => (
    <div
      key={key}
      style={{
        position: "absolute",
        top,
        height: LABEL_H,
        display: "flex",
        alignItems: "center",
        fontSize: 21,
        color: OG.textDim,
        ...style,
      }}
    >
      {text}
    </div>
  );
  return (
    <>
      {geometry.leftTicks.map((t) =>
        label(
          `l-${t.y}`,
          PLOT_TOP + t.y - LABEL_H / 2,
          {
            left: PAD_X,
            width: AXIS_W - AXIS_GAP,
            justifyContent: "flex-end",
          },
          t.label,
        ),
      )}
      {geometry.rightTicks.map((t) =>
        label(
          `r-${t.y}`,
          PLOT_TOP + t.y - LABEL_H / 2,
          { left: plotRight + AXIS_GAP, width: AXIS_W - AXIS_GAP },
          t.label,
        ),
      )}
      {geometry.dateLabels.map((d) => {
        const top = PLOT_TOP + geometry.height + 10;
        const x = PLOT_LEFT + d.x;
        // Anchored by left + width only: satori drops an absolutely
        // positioned label anchored by `right` alone.
        const style =
          d.align === "start"
            ? { left: x, width: DATE_W }
            : d.align === "end"
              ? { left: x - DATE_W, width: DATE_W, justifyContent: "flex-end" }
              : {
                  left: x - DATE_W / 2,
                  width: DATE_W,
                  justifyContent: "center",
                };
        return label(`d-${d.x}`, top, style, d.label);
      })}
    </>
  );
}

/**
 * The card. With nothing to draw (a failed read, an empty period) it says so
 * in the plot's place and keeps the header and brand, so a share still
 * unfurls into something true rather than empty axes or a 500.
 */
export function OgChartCard({
  code,
  company,
  view,
  subject,
  periodPhrase,
  source,
  short,
  price,
  logoSrc,
  brand,
}: OgChartCardProps) {
  const showShort = view !== "price";
  const showPrice = view !== "short";
  const shortChange = showShort ? seriesChange(short) : null;
  const priceChange = showPrice ? seriesChange(price) : null;

  const hasRightAxis =
    view === "combined" && short.length > 0 && price.length > 0;
  const plotRight = W - PAD_X - (hasRightAxis ? AXIS_W : 0);
  const geometry = buildChartGeometry({
    view,
    short,
    price,
    width: plotRight - PLOT_LEFT,
    height: PLOT_H,
  });

  // As of the series the view is about, as the interactive embed dates it.
  const asOfSeries = view === "price" ? price : short.length ? short : price;
  const asOf = asOfSeries.length
    ? formatDate(asOfSeries[asOfSeries.length - 1]!.t)
    : null;

  // The same 0.05% threshold below which formatPriceChange prints "0.0%".
  const pricePct = priceChange?.pct ?? null;
  const priceTone =
    pricePct !== null && Math.abs(pricePct) >= 0.05
      ? pricePct > 0
        ? UP
        : DOWN
      : OG.text;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        backgroundColor: OG.bg,
        // linear-gradient only: satori cannot parse radial-gradient.
        backgroundImage: `linear-gradient(135deg, ${OG.bg} 0%, ${OG.bgAlt} 55%, ${OG.bg} 100%)`,
      }}
    >
      {/* top rule, as on every other card */}
      <div
        style={{
          display: "flex",
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 8,
          backgroundImage: `linear-gradient(90deg, ${OG.orange} 0%, ${OG.orangeDim} 100%)`,
        }}
      />

      {/* header: who and what */}
      <div
        style={{
          position: "absolute",
          top: 40,
          left: PAD_X,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
          {brand?.src && <OgLogoChip logo={brand} size={76} />}
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{
                display: "flex",
                fontSize: 80,
                fontWeight: 800,
                lineHeight: 1,
                letterSpacing: -1,
                color: OG.text,
              }}
            >
              {code}
            </div>
            {company && company !== code && (
              <div
                style={{
                  display: "flex",
                  marginTop: 6,
                  fontSize: 26,
                  color: OG.textDim,
                  maxWidth: 500,
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  textOverflow: "ellipsis",
                }}
              >
                {company}
              </div>
            )}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 16,
            fontSize: 26,
            fontWeight: 600,
            color: OG.orange,
            maxWidth: 640,
          }}
        >
          {`${subject} · ${periodPhrase}`}
        </div>
      </div>

      {/* readouts: the latest of each series and its change over the period */}
      <div
        style={{
          position: "absolute",
          top: 40,
          right: PAD_X,
          display: "flex",
          gap: 52,
        }}
      >
        {showPrice && priceChange && (
          <Readout
            color={PRICE}
            label="Share price"
            value={formatPrice(priceChange.last)}
            change={
              priceChange.pct !== null
                ? formatPriceChange(priceChange.pct)
                : null
            }
            changeColor={priceTone}
          />
        )}
        {showShort && shortChange && (
          <Readout
            color={SHORT}
            label="Short interest"
            value={formatShort(shortChange.last)}
            // Short interest is not market direction: never red or green.
            change={formatShortChange(shortChange.delta)}
            changeColor={OG.text}
          />
        )}
      </div>

      {geometry ? (
        <>
          <div
            style={{
              position: "absolute",
              top: PLOT_TOP,
              left: PLOT_LEFT,
              display: "flex",
            }}
          >
            <PlotSvg geometry={geometry} />
          </div>
          <AxisLabels geometry={geometry} plotRight={plotRight} />
        </>
      ) : (
        <div
          style={{
            position: "absolute",
            top: PLOT_TOP,
            left: PAD_X,
            right: PAD_X,
            height: PLOT_H,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            border: `2px dashed ${OG.border}`,
            borderRadius: 16,
          }}
        >
          <div style={{ display: "flex", fontSize: 38, color: OG.text }}>
            Chart data unavailable
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 12,
              fontSize: 24,
              color: OG.textDim,
            }}
          >
            {`See the live chart at shorted.com.au/shorts/${code}`}
          </div>
        </div>
      )}

      {/* footer: brand, then the date and where the data comes from */}
      <div
        style={{
          position: "absolute",
          left: PAD_X,
          right: PAD_X,
          bottom: 26,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderTop: `1px solid ${OG.border}`,
          paddingTop: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {logoSrc && (
            <img
              src={logoSrc}
              width={36}
              height={36}
              style={{ borderRadius: 6 }}
            />
          )}
          <div
            style={{
              display: "flex",
              fontSize: 26,
              fontWeight: 700,
              color: OG.orange,
            }}
          >
            shorted.com.au
          </div>
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 19,
            color: OG.textDim,
            maxWidth: 780,
            overflow: "hidden",
            whiteSpace: "nowrap",
            textOverflow: "ellipsis",
          }}
        >
          {asOf ? `As of ${asOf} · ${source}` : source}
        </div>
      </div>
    </div>
  );
}
