"use client";

import { useMemo, useState } from "react";

import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { lgaCodesFromColumn } from "@/lib/housing/council-geometry";
import {
  COUNCIL_METRICS, DEFAULT_COUNCIL_METRIC, type CouncilMetricKey,
} from "@/lib/housing/council-metrics";
import type { TimestampLike } from "@/lib/housing/drops-freshness";
import { CouncilLevelMap, type CouncilMapRow } from "../council-level-map";
import { HousingIcon } from "../housing-icon";
import { useSuburbColumns } from "../use-suburb-columns";
import { useTopojson } from "../use-topojson";

export interface CouncilIndexMapProps {
  stateCode: string;
  /** The same ListCouncils rows the table renders, as plain JSON. */
  councils: readonly CouncilMapRow[];
  /** ListCouncils' drops freshness stamps, as plain JSON (dates the drops legend). */
  dropsStamps?: { asOf?: TimestampLike; dataThrough?: TimestampLike };
}

const LGA_COLUMN = ["lga_code"] as const;

/** The map frame's height class; >= ChoroplethMap's own 460px fill floor. */
export const COUNCIL_INDEX_MAP_HEIGHT = "h-[480px]";

/**
 * The state council index's choropleth: the council level of the state map,
 * fed by the rows the server already fetched (no second ListCouncils call).
 * Shapes are merged from the suburb topology on the client, exactly as on the
 * state map, so this adds no geometry asset.
 */
export function CouncilIndexMap({ stateCode, councils, dropsStamps }: CouncilIndexMapProps) {
  const [metricKey, setMetricKey] = useState<CouncilMetricKey>(DEFAULT_COUNCIL_METRIC);
  const { data: topo, isError } = useTopojson(`/geo/suburbs/${stateCode}.topojson`);
  const column = useSuburbColumns(stateCode, LGA_COLUMN);
  const lgaBySal = useMemo(() => lgaCodesFromColumn(column.data?.get("lga_code")), [column.data]);
  // Offer only metrics at least one council in this state has.
  const metrics = useMemo(() => COUNCIL_METRICS.filter((m) => councils.some((c) => m.value(c) != null)), [councils]);

  const failed = isError || (!column.isLoading && !column.data);
  const ready = topo && lgaBySal.size > 0;

  return (
    <div className="flex flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="shrink-0 text-xs text-muted-foreground">Colour by</span>
        <Select value={metricKey} onValueChange={(v) => setMetricKey(v as CouncilMetricKey)}>
          <SelectTrigger aria-label="Colour the councils by" className="h-8 min-w-0 flex-1 text-xs sm:w-[240px] sm:flex-none">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {metrics.map((m) => (
              <SelectItem key={m.key} value={m.key}>
                <span className="flex items-center gap-2">
                  <HousingIcon name={m.icon} size={16} />
                  {m.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {/* A DEFINITE height, not a min-height: the choropleth fills its parent
          through ParentSize (height: 100%), and a percentage of a min-height-only
          box resolves to 0 — the map measured 1120x0 and never mounted. The
          state map gets away with min-heights only because its grid row gives
          the chain a definite height; this section has none. */}
      <div className={`relative flex ${COUNCIL_INDEX_MAP_HEIGHT} flex-col overflow-hidden rounded-xl`} data-testid="council-index-map-frame">
        {failed ? (
          <div className="absolute inset-0 flex items-center justify-center bg-muted/30 p-6 text-center text-sm text-muted-foreground" role="status">
            Council map unavailable right now — every council is in the table below.
          </div>
        ) : ready ? (
          <CouncilLevelMap
            stateCode={stateCode}
            topology={topo}
            objectName={Object.keys(topo.objects)[0]!}
            lgaBySal={lgaBySal}
            councils={councils}
            metricKey={metricKey}
            dropsStamps={dropsStamps}
          />
        ) : (
          <div className="absolute inset-0 animate-pulse bg-muted motion-reduce:animate-none" role="status" aria-label="Loading the council map" />
        )}
      </div>
    </div>
  );
}
