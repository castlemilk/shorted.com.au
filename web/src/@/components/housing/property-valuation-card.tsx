"use client";

import { useState } from "react";
import type { PropertyValuation } from "~/gen/shorts/v1alpha1/housing_pb";
import { fmtPriceShort } from "@/lib/housing/price-scale";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { HousingIcon } from "./housing-icon";

const SALES_VISIBLE_LIMIT = 8;
const BUILDING_ESTIMATE_TOOLTIP =
  "This unit isn’t individually indexed by the valuation source, so this is the estimate for the whole building — not this specific unit.";

function fmtDate(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function BuildingEstimateBadge() {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex cursor-help items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-700 outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 dark:text-amber-300"
          >
            Building estimate
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <p className="text-xs leading-relaxed">{BUILDING_ESTIMATE_TOOLTIP}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function PropertyValuationCard({
  valuation,
}: {
  valuation: PropertyValuation;
}) {
  const [showAllSales, setShowAllSales] = useState(false);
  const hasEstimate = valuation.estimateMid > 0;
  const hasRange =
    valuation.estimateLow > 0 && valuation.estimateHigh > valuation.estimateLow;
  const isBuilding = valuation.valuationGranularity === "building";
  const confidence = valuation.estimateConfidence.trim().toLowerCase();
  const rangePosition = hasRange
    ? Math.min(
        100,
        Math.max(
          0,
          ((valuation.estimateMid - valuation.estimateLow) /
            (valuation.estimateHigh - valuation.estimateLow)) *
            100,
        ),
      )
    : 0;

  const bedBathCar = [
    valuation.bedrooms > 0 ? `${valuation.bedrooms} bd` : "",
    valuation.bathrooms > 0 ? `${valuation.bathrooms} ba` : "",
    valuation.carSpaces > 0 ? `${valuation.carSpaces} car` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const attributes = [
    bedBathCar,
    valuation.landSizeSqm > 0
      ? `${Math.round(valuation.landSizeSqm)}m² land`
      : "",
    valuation.buildingSizeSqm > 0
      ? `${Math.round(valuation.buildingSizeSqm)}m² floor`
      : "",
    valuation.yearBuilt > 0 ? `Built ${valuation.yearBuilt}` : "",
    valuation.propertyType,
  ].filter(Boolean);
  const visibleSales = showAllSales
    ? valuation.salesHistory
    : valuation.salesHistory.slice(0, SALES_VISIBLE_LIMIT);

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="flex items-center gap-2 font-serif text-lg text-foreground">
          <HousingIcon name="median-price" size={20} />
          {hasEstimate ? "Estimated value" : "Property details"}
        </h2>
        <div className="text-right text-xs text-muted-foreground">
          <p>property.com.au estimate</p>
          {valuation.profileUrl ? (
            <a
              href={valuation.profileUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="mt-1 inline-flex font-medium text-foreground underline-offset-4 hover:underline"
            >
              View on property.com.au ↗
            </a>
          ) : null}
        </div>
      </div>

      {hasEstimate ? (
        <div className="mt-5">
          <div className="flex flex-wrap items-center gap-2.5">
            <p className="font-mono text-3xl font-semibold tabular-nums text-foreground sm:text-4xl">
              {fmtPriceShort(valuation.estimateMid)}
            </p>
            {isBuilding ? <BuildingEstimateBadge /> : null}
            {confidence ? (
              <span className="inline-flex items-center rounded-full border border-border bg-muted/50 px-2.5 py-0.5 text-xs text-muted-foreground">
                {confidence} confidence
              </span>
            ) : null}
          </div>

          {valuation.estimateLow > 0 && valuation.estimateHigh > 0 ? (
            <p className="mt-1.5 font-mono text-sm tabular-nums text-muted-foreground">
              {fmtPriceShort(valuation.estimateLow)} –{" "}
              {fmtPriceShort(valuation.estimateHigh)} range
            </p>
          ) : null}

          {hasRange ? (
            <div
              role="img"
              aria-label={`Estimated value range from ${fmtPriceShort(valuation.estimateLow)} to ${fmtPriceShort(valuation.estimateHigh)}`}
              className="relative mt-3 h-2 rounded-full bg-muted"
            >
              <span
                aria-hidden
                className="absolute top-1/2 h-4 w-1 rounded-full bg-amber-500 shadow-sm"
                style={{
                  left: `${rangePosition}%`,
                  transform: "translate(-50%, -50%)",
                }}
              />
            </div>
          ) : null}

          {isBuilding ? (
            <p className="mt-3 text-sm leading-relaxed text-amber-700 dark:text-amber-300">
              Whole-building estimate — this specific unit isn’t individually
              valued.
            </p>
          ) : null}
        </div>
      ) : confidence ? (
        <span className="mt-4 inline-flex items-center rounded-full border border-border bg-muted/50 px-2.5 py-0.5 text-xs text-muted-foreground">
          {confidence} confidence
        </span>
      ) : null}

      {attributes.length > 0 ? (
        <div className="mt-5 flex flex-wrap gap-2">
          {attributes.map((attribute) => (
            <span
              key={attribute}
              className="inline-flex items-center rounded-full border border-border bg-muted/50 px-2.5 py-1 text-xs text-muted-foreground"
            >
              {attribute}
            </span>
          ))}
        </div>
      ) : null}

      {valuation.rentEstimateMid > 0 ? (
        <p className="mt-4 flex items-center gap-1.5 font-mono text-sm tabular-nums text-foreground">
          <HousingIcon name="rent" size={16} />~
          {fmtPriceShort(valuation.rentEstimateMid)}/wk est. rent
        </p>
      ) : null}

      {valuation.salesHistory.length > 0 ? (
        <div className="mt-5 border-t border-border pt-5">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="font-serif text-base text-foreground">
              Sales history
            </h3>
            <p className="text-[11px] text-muted-foreground">
              property.com.au transaction record
            </p>
          </div>
          <ul className="divide-y divide-border">
            {visibleSales.map((sale, index) => (
              <li
                key={`${sale.date}-${sale.eventType}-${index}`}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  {sale.eventType ? (
                    <span className="inline-flex items-center rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {sale.eventType}
                    </span>
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    {fmtDate(sale.date) || sale.date || "Date unavailable"}
                  </span>
                </div>
                <div className="ml-auto text-right">
                  <p className="font-mono text-sm tabular-nums text-foreground">
                    {sale.price > 0
                      ? fmtPriceShort(sale.price)
                      : "Price undisclosed"}
                  </p>
                  {sale.agency ? (
                    <p className="text-[11px] text-muted-foreground">
                      {sale.agency}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {valuation.salesHistory.length > SALES_VISIBLE_LIMIT ? (
            <button
              type="button"
              onClick={() => setShowAllSales((current) => !current)}
              className="mt-3 text-xs font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {showAllSales
                ? "Show less"
                : `Show all (${valuation.salesHistory.length})`}
            </button>
          ) : null}
        </div>
      ) : null}

      <footer className="mt-5 border-t border-border pt-4 text-[11px] leading-relaxed text-muted-foreground">
        <p>
          Estimate as at {fmtDate(valuation.fetchedAt) || "date unavailable"}
        </p>
        <p className="mt-1">
          Estimate data: property.com.au. Figures are model estimates, not
          appraisals.
        </p>
      </footer>
    </section>
  );
}
