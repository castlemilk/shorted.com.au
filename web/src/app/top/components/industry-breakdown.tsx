"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { PieChart, ChevronRight } from "lucide-react";
import { type SerializedTimeSeriesData } from "~/app/actions/top/getTopPageData";
import { cn } from "~/@/lib/utils";
import { formatPercentage } from "~/@/lib/shorts-calculations";
import { getSectorImagePath, getSectorImageAlt } from "~/@/lib/sector-images";

interface IndustryBreakdownProps {
  data: SerializedTimeSeriesData[];
}

// Industry mapping based on stock codes (simplified - in production, this would come from API)
const stockIndustryMap: Record<string, string> = {
  // Mining / Resources
  BHP: "Mining", RIO: "Mining", FMG: "Mining", MIN: "Mining", PLS: "Mining",
  LYC: "Mining", IGO: "Mining", S32: "Mining", SFR: "Mining", AWC: "Mining",
  OZL: "Mining", NCM: "Mining", NST: "Mining", EVN: "Mining", NHC: "Mining",
  WHC: "Mining", BOE: "Mining", PDN: "Mining", DYL: "Mining", BMN: "Mining",
  LOT: "Mining", ERA: "Mining", AGE: "Mining",
  // Banks
  CBA: "Banks", WBC: "Banks", NAB: "Banks", ANZ: "Banks", MQG: "Banks",
  BEN: "Banks", BOQ: "Banks",
  // Healthcare
  CSL: "Healthcare", COH: "Healthcare", RMD: "Healthcare", SHL: "Healthcare",
  RHC: "Healthcare", PME: "Healthcare", NAN: "Healthcare", MSB: "Healthcare",
  IMU: "Healthcare",
  // Retail
  WES: "Retail", WOW: "Retail", JBH: "Retail", HVN: "Retail", SUL: "Retail",
  PMV: "Retail", LOV: "Retail", BBN: "Retail", KGN: "Retail", TPW: "Retail",
  // Technology
  WTC: "Technology", XRO: "Technology", REA: "Technology", CAR: "Technology",
  SEK: "Technology", APX: "Technology", TNE: "Technology", NXT: "Technology",
  MP1: "Technology",
  // Property / REITs
  GMG: "Property", SCG: "Property", VCX: "Property", MGR: "Property",
  GPT: "Property", SGP: "Property", CHC: "Property", LLC: "Property", ABP: "Property",
  // Energy
  WDS: "Energy", STO: "Energy", ORG: "Energy", AGL: "Energy", APA: "Energy",
  // Telecom
  TLS: "Telecom", TPG: "Telecom",
  // Insurance
  QBE: "Insurance", IAG: "Insurance", SUN: "Insurance",
  // Industrials
  BXB: "Industrials", TCL: "Industrials", SYD: "Industrials", QAN: "Industrials",
  ALQ: "Industrials",
  // Food & Beverage
  TWE: "Food & Bev", A2M: "Food & Bev", BGA: "Food & Bev", GNC: "Food & Bev",
  ING: "Food & Bev",
};

// Warm-system series voices only: amber (primary), rust (accent), avocado
// (secondary), muted for the residual bucket. Tokens, so both rooms are correct.
const AMBER = { bg: "bg-primary/20", border: "border-primary/70", text: "text-primary" };
const RUST = { bg: "bg-accent/25", border: "border-accent/70", text: "text-accent" };
const AVOCADO = { bg: "bg-secondary/25", border: "border-secondary/70", text: "text-secondary" };
const NEUTRAL = { bg: "bg-muted", border: "border-border", text: "text-muted-foreground" };

const industryColors: Record<string, { bg: string; border: string; text: string }> = {
  Mining: AMBER,
  Banks: RUST,
  Healthcare: AVOCADO,
  Retail: AMBER,
  Technology: RUST,
  Property: AVOCADO,
  Energy: AMBER,
  Telecom: RUST,
  Insurance: AVOCADO,
  Industrials: AMBER,
  "Food & Bev": RUST,
  Other: NEUTRAL,
};

export function IndustryBreakdown({ data }: IndustryBreakdownProps) {
  const [expandedIndustry, setExpandedIndustry] = useState<string | null>(null);

  const industryData = useMemo(() => {
    const grouped: Record<
      string,
      {
        count: number;
        avgShort: number;
        maxShort: number;
        stocks: Array<{ code: string; name: string; shortPct: number }>;
      }
    > = {};

    data.forEach((stock) => {
      const industry = stockIndustryMap[stock.productCode ?? ""] ?? "Other";
      if (!grouped[industry]) {
        grouped[industry] = { count: 0, avgShort: 0, maxShort: 0, stocks: [] };
      }
      const group = grouped[industry]!;
      group.count++;
      group.avgShort += stock.latestShortPosition ?? 0;
      group.maxShort = Math.max(group.maxShort, stock.latestShortPosition ?? 0);
      group.stocks.push({
        code: stock.productCode ?? "",
        name: stock.name ?? "",
        shortPct: stock.latestShortPosition ?? 0,
      });
    });

    // Calculate averages and sort stocks
    Object.keys(grouped).forEach((industry) => {
      const group = grouped[industry]!;
      group.avgShort /= group.count;
      group.stocks.sort((a, b) => b.shortPct - a.shortPct);
    });

    // Convert to array and sort by count
    const defaultColors = NEUTRAL;
    return Object.entries(grouped)
      .map(([industry, stats]) => ({
        industry,
        ...stats,
        colors: industryColors[industry] ?? defaultColors,
      }))
      .sort((a, b) => b.count - a.count);
  }, [data]);

  const totalStocks = data.length;

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <PieChart className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-xl font-semibold">Industry Breakdown</h2>
      </div>

      {/* Industry bars */}
      <div className="space-y-3">
        {industryData.map(({ industry, count, avgShort, maxShort, stocks, colors }) => {
          const percentage = (count / totalStocks) * 100;
          const isExpanded = expandedIndustry === industry;

          return (
            <div key={industry}>
              {/* Industry bar */}
              <button
                onClick={() => setExpandedIndustry(isExpanded ? null : industry)}
                className={cn(
                  "w-full rounded-lg border transition-colors duration-200 ease-out",
                  "hover:bg-muted/30",
                  isExpanded
                    ? `${colors.bg} ${colors.border}`
                    : "border-border/40 bg-card/30"
                )}
                aria-expanded={isExpanded}
                aria-controls={`industry-${industry.replace(/\s+/g, "-").toLowerCase()}-stocks`}
              >
                <div className="p-4">
                  <span className="sr-only">
                    {industry}: {count} stocks, average {formatPercentage(avgShort)}, max {formatPercentage(maxShort)}.
                    Press to {isExpanded ? "collapse" : "expand"}.
                  </span>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-3">
                      <Image
                        src={getSectorImagePath(industry)}
                        alt={getSectorImageAlt(industry)}
                        width={36}
                        height={36}
                        className="rounded-sm"
                      />
                      <span className="font-medium">{industry}</span>
                      <span className="text-xs text-muted-foreground">
                        {count} stocks
                      </span>
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="text-right">
                        <div className="text-xs text-muted-foreground">Avg</div>
                        <div className="text-sm font-semibold tabular-nums">
                          {formatPercentage(avgShort)}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-xs text-muted-foreground">Max</div>
                        <div
                          className={cn(
                            "text-sm font-semibold tabular-nums",
                            maxShort > 15 ? "text-red-500" : maxShort > 10 ? "text-orange-500" : "text-foreground"
                          )}
                        >
                          {formatPercentage(maxShort)}
                        </div>
                      </div>
                      <ChevronRight
                        className={cn(
                          "h-4 w-4 text-muted-foreground transition-transform",
                          isExpanded && "rotate-90"
                        )}
                        aria-hidden="true"
                      />
                    </div>
                  </div>

                  {/* Progress bar */}
                  <div className="h-2 bg-muted/30 rounded-full overflow-hidden">
                    <div
                      className={cn("h-full rounded-full transition-[width] duration-500 ease-out", colors.bg, colors.border, "border")}
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                </div>
              </button>

              {/* Expanded stock list */}
              {isExpanded && (
                <div
                  id={`industry-${industry.replace(/\s+/g, "-").toLowerCase()}-stocks`}
                  className="pt-2 pb-4 px-4 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2 animate-fade-in"
                  role="region"
                  aria-label={`${industry} stocks`}
                >
                  {stocks.slice(0, 12).map((stock) => (
                    <a
                      key={stock.code}
                      href={`/shorts/${stock.code}`}
                      className={cn(
                        "p-2 rounded border text-sm hover:bg-muted/50 transition-colors",
                        "border-border bg-background"
                      )}
                    >
                      <div className="font-medium">{stock.code}</div>
                      <div
                        className={cn(
                          "text-xs tabular-nums",
                          stock.shortPct > 15 ? "text-red-500" : stock.shortPct > 10 ? "text-orange-500" : "text-muted-foreground"
                        )}
                      >
                        {formatPercentage(stock.shortPct)}
                      </div>
                    </a>
                  ))}
                  {stocks.length > 12 && (
                    <div className="p-2 rounded border border-border/40 bg-background/50 flex items-center justify-center text-xs text-muted-foreground">
                      +{stocks.length - 12} more
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
