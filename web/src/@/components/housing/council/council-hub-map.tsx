"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";

import { ChoroplethMap, type LineLayer } from "../choropleth-map";
import { useTopojson } from "../use-topojson";
import { useSuburbColumns } from "../use-suburb-columns";
import { lgaCodesFromColumn, unionOf } from "@/lib/housing/council-geometry";
import { suburbHref } from "@/lib/housing/states";

export interface CouncilHubMapSuburb {
  salCode: string;
  salName: string;
  postcode: string;
  /** 0..1 of the suburb's residents in this council. */
  share: number;
  dominant: boolean;
}

export interface CouncilHubMapProps {
  stateCode: string;
  lgaCode: string;
  councilName: string;
  suburbs: readonly CouncilHubMapSuburb[];
  neighbourCodes: readonly string[];
}

const LGA_COLUMN = ["lga_code"] as const;
const MEMBER = 2;
const STRADDLER = 1;

/**
 * The council within its state: member suburbs filled (straddlers lighter),
 * the council outline merged from the suburbs it holds most residents of, and
 * each neighbouring council's outline dashed. Everything is derived from the
 * state suburb topology already cached for the explorer — no new asset.
 */
export function CouncilHubMap({ stateCode, lgaCode, councilName, suburbs, neighbourCodes }: CouncilHubMapProps) {
  const router = useRouter();
  const { data: topo, isError } = useTopojson(`/geo/suburbs/${stateCode}.topojson`);
  const columns = useSuburbColumns(stateCode, neighbourCodes.length ? LGA_COLUMN : []);
  const lgaBySal = useMemo(() => lgaCodesFromColumn(columns.data?.get("lga_code")), [columns.data]);

  const bySal = useMemo(() => new Map(suburbs.map((s) => [s.salCode, s])), [suburbs]);
  const valueById = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const s of suburbs) m.set(s.salCode, s.dominant ? MEMBER : STRADDLER);
    return m;
  }, [suburbs]);
  const nameById = useMemo(() => new Map(suburbs.map((s) => [s.salCode, s.salName])), [suburbs]);

  const lines = useMemo((): LineLayer[] | undefined => {
    if (!topo) return undefined;
    const objectName = Object.keys(topo.objects)[0]!;
    const out: LineLayer[] = [];
    if (lgaBySal.size > 0 && neighbourCodes.length) {
      const wanted = new Set(neighbourCodes);
      const groups = new Map<string, Set<string>>();
      for (const [sal, code] of lgaBySal) {
        if (!code || !wanted.has(code)) continue;
        const g = groups.get(code);
        if (g) g.add(sal);
        else groups.set(code, new Set([sal]));
      }
      for (const [code, sals] of groups) {
        const outline = unionOf(topo, objectName, sals);
        if (outline) out.push({ key: `neighbour-${code}`, geometry: outline, width: 1, dash: "3 3", opacity: 0.55 });
      }
    }
    const own = unionOf(topo, objectName, new Set(suburbs.filter((s) => s.dominant).map((s) => s.salCode)));
    if (own) out.push({ key: `council-${lgaCode}`, geometry: own, width: 2.2, opacity: 0.95 });
    return out;
  }, [topo, lgaBySal, neighbourCodes, suburbs, lgaCode]);

  if (isError) {
    return (
      <div className="flex h-[420px] items-center justify-center rounded-xl border border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        Map unavailable — the suburbs are listed below.
      </div>
    );
  }
  if (!topo) return <div className="h-[420px] w-full animate-pulse rounded-xl bg-muted" />;
  const objectName = Object.keys(topo.objects)[0]!;
  const scale = (v: number) => (v >= MEMBER ? "hsl(var(--primary) / 0.55)" : "hsl(var(--primary) / 0.22)");

  return (
    <div className="relative h-[420px] overflow-hidden rounded-xl border border-border">
      <ChoroplethMap
        fill
        topology={topo}
        objectName={objectName}
        valueById={valueById}
        colorScale={scale}
        fitValueById={valueById}
        fitToData
        hatchNoData={false}
        nameById={nameById}
        lines={lines}
        ariaLabel={`${councilName}: its suburbs within ${stateCode}`}
        onFeatureClick={(sal) => {
          const s = bySal.get(sal);
          if (s) router.push(suburbHref(stateCode, s));
        }}
        legend={
          <div className="pointer-events-none rounded-lg border border-border bg-card/90 px-3 py-2 text-[10px] text-muted-foreground shadow-sm backdrop-blur">
            <div className="flex items-center gap-1.5"><Swatch alpha={0.55} /> Mostly in {councilName}</div>
            <div className="mt-1 flex items-center gap-1.5"><Swatch alpha={0.22} /> Partly in it (5%+ of residents)</div>
            <div className="mt-1 flex items-center gap-1.5"><span className="inline-block h-0 w-4 border-t-2 border-foreground" /> Council outline (ABS mesh-block allocation)</div>
            {neighbourCodes.length ? (
              <div className="mt-1 flex items-center gap-1.5"><span className="inline-block h-0 w-4 border-t border-dashed border-foreground" /> Neighbouring councils</div>
            ) : null}
          </div>
        }
      />
    </div>
  );
}

function Swatch({ alpha }: { alpha: number }) {
  return <span className="inline-block h-3 w-3 rounded-sm border border-border" style={{ background: `hsl(var(--primary) / ${alpha})` }} />;
}
