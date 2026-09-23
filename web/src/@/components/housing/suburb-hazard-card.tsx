// NO "use client" — rendered inside the server-side suburb profile body. Pure
// props in, markup out; the numbers are already on GetSuburbProfileResponse.
import Link from "next/link";
import type { SuburbElevation, SuburbHazardExposure } from "~/gen/shorts/v1alpha1/housing_pb";
import { OVERLAY_BY_KEY, overlayAvailable, overlayCaveat, serializeOverlayParam, type OverlayKey } from "@/lib/housing/overlays";
import { STATE_NAMES, stateSlug } from "@/lib/housing/states";
import { HousingIcon, type HousingIconName } from "./housing-icon";

/**
 * Terrain & hazard exposure — the one card on the profile that talks about
 * water and fire, so its wording is held to the data-sources.md standard:
 * measured facts with the instrument named, and "observed", never "risk".
 *
 * A share that is genuinely 0 renders as 0%; a share with no source renders
 * nothing (and the state-level note says why). The elevation block is the
 * DEM pipeline that was built in #504 and never surfaced.
 */
export function SuburbHazardCard({
  elevation, hazards, stateCode, salCode,
}: {
  elevation?: SuburbElevation;
  hazards?: SuburbHazardExposure;
  stateCode: string;
  salCode: string;
}) {
  const medianM = elevation?.elevationMedianM;
  const water = hazards?.waterObservedSharePct;
  const flood = hazards?.floodPlanningSharePct;
  const fire = hazards?.bushfireProneSharePct;
  const hasElevation = medianM !== undefined;
  const hasWater = water !== undefined;
  const hasFlood = flood !== undefined;
  const hasFire = fire !== undefined;
  if (!hasElevation && !hasWater && !hasFlood && !hasFire) return null;

  const stateName = STATE_NAMES[stateCode] ?? stateCode;
  const mapHref = (overlay: OverlayKey) =>
    `/housing/${stateSlug(stateCode)}?sal=${salCode}&overlays=${serializeOverlayParam([overlay])}`;
  // Per hazard: QLD and WA publish a bushfire layer but no open flood layer.
  const floodInState = overlayAvailable("flood_planning", stateCode);
  const fireInState = overlayAvailable("bushfire_prone", stateCode);
  // In a state that has the layer, a null share means the source's instruments
  // do not reach this suburb (NSW: no council flood map lodged). Say so in the
  // tile rather than dropping it, which would read the same as "no hazard".
  // Only with a hazards row: no row at all means "not computed", not "uncovered".
  const floodUncovered = hazards && floodInState && flood === undefined ? OVERLAY_BY_KEY.flood_planning.uncovered?.[stateCode] : undefined;
  const fireUncovered = hazards && fireInState && fire === undefined ? OVERLAY_BY_KEY.bushfire_prone.uncovered?.[stateCode] : undefined;
  const missingLayers = [!floodInState && "flood", !fireInState && "bushfire"].filter(Boolean).join(" or ");

  const tiles: HazardTile[] = [];
  if (medianM !== undefined) {
    const minM = elevation?.elevationMinM;
    const maxM = elevation?.elevationMaxM;
    tiles.push({
      key: "elevation", icon: "hills-ranges", label: "Median elevation",
      value: `${Math.round(medianM)} m`,
      note: minM !== undefined && maxM !== undefined
        ? `range ${Math.round(Math.max(0, minM))}–${Math.round(maxM)} m`
        : undefined,
    });
    const below5 = elevation?.landShareBelow5m;
    const below2 = elevation?.landShareBelow2m;
    if (below5 !== undefined) {
      tiles.push({
        key: "low", icon: "coastal-beach", label: "Land below 5 m",
        value: fmtShare(below5),
        note: below2 !== undefined ? `${fmtShare(below2)} below 2 m` : undefined,
      });
    }
  }
  if (water !== undefined) {
    const permanent = hazards?.permanentWaterSharePct;
    tiles.push({
      key: "water", icon: "river-valley", label: OVERLAY_BY_KEY.water_observed.shareLabel,
      value: fmtShare(water),
      note: permanent !== undefined && permanent > 0 ? `plus ${fmtShare(permanent)} permanent water` : undefined,
      href: mapHref("water_observed"),
    });
  }
  if (flood !== undefined || floodUncovered) {
    tiles.push({
      key: "flood", icon: "harbour", label: OVERLAY_BY_KEY.flood_planning.shareLabel,
      value: flood !== undefined ? fmtShare(flood) : NOT_MAPPED,
      note: flood !== undefined ? sourceLabel(hazards?.floodSource ?? "") : "no statutory layer here",
      href: mapHref("flood_planning"),
    });
  }
  if (fire !== undefined || fireUncovered) {
    tiles.push({
      key: "fire", icon: "bushland", label: OVERLAY_BY_KEY.bushfire_prone.shareLabel,
      value: fire !== undefined ? fmtShare(fire) : NOT_MAPPED,
      note: fire !== undefined ? sourceLabel(hazards?.bushfireSource ?? "") : "no statutory layer here",
      href: mapHref("bushfire_prone"),
    });
  }

  return (
    <section aria-labelledby="hazard-heading">
      <h2 id="hazard-heading" className="mb-3 flex items-center gap-2.5 font-serif text-2xl text-foreground">
        <HousingIcon name="river-valley" size={26} /> Terrain &amp; hazard exposure
      </h2>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="-mb-px -mr-px grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
          {tiles.map((t) => (
            <article key={t.key} aria-label={t.label} className="flex flex-col gap-1 border-b border-r border-border px-3 py-3 sm:flex-row sm:items-start sm:gap-2.5 sm:px-3.5">
              <HousingIcon name={t.icon} size={22} className="shrink-0 sm:mt-0.5" />
              <div className="min-w-0">
                <div className="text-[11px] leading-tight text-muted-foreground">{t.label}</div>
                <div className="mt-0.5 font-mono text-[15px] font-semibold tabular-nums text-foreground">{t.value}</div>
                {t.note ? <div className="mt-0.5 text-[10px] text-muted-foreground">{t.note}</div> : null}
                {t.href ? (
                  <Link href={t.href} className="mt-1 inline-block text-[11px] text-primary transition-colors hover:text-foreground">
                    Show on map →
                  </Link>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </div>
      <p className="mt-2.5 text-[11px] text-muted-foreground [text-wrap:pretty]">
        Shares are the proportion of the suburb&apos;s land area. {hasWater ? OVERLAY_BY_KEY.water_observed.caveat + " " : ""}
        {hasFlood ? overlayCaveat("flood_planning", stateCode) + " " : ""}
        {floodUncovered ? floodUncovered + " " : ""}
        {hasFire ? overlayCaveat("bushfire_prone", stateCode) + " " : ""}
        {fireUncovered ? fireUncovered + " " : ""}
        {hasElevation ? "Elevation is orthometric height from a 30 m model; no hydrology or drainage is modelled. " : ""}
        {missingLayers ? `No open statutory ${missingLayers} layer is published for ${stateName} yet.` : ""}
      </p>
    </section>
  );
}

type HazardTile = {
  key: string;
  icon: HousingIconName;
  label: string;
  value: string;
  note?: string;
  href?: string;
};

export function fmtShare(v: number): string {
  if (v === 0) return "0%";
  if (v < 0.05) return "<0.1%";
  if (v < 10) return `${v.toFixed(1)}%`;
  return `${Math.round(v)}%`;
}

/** Tile value for a null share in a state that has the layer: never "0%". */
const NOT_MAPPED = "Not mapped";

// Keyed by the collector's hazardVectorSources ids (house-price-collector/hazards.go).
const SOURCE_LABELS: Record<string, string> = {
  nsw_epi_flood: "NSW EPI Flood",
  vic_plan_overlay_lsio_fo_sbo: "Vicmap LSIO / FO / SBO",
  sa_pdcode_hazards_flooding: "SA Code Hazards (Flooding)",
  tas_tps_flood_prone: "TPS Flood-prone Areas",
  act_flood_extent_1pct_aep: "ACT 1% AEP flood model",
  nsw_bfpl: "NSW RFS Bush Fire Prone Land",
  vic_bpa: "VIC Bushfire Prone Area",
  qld_qfd_bpa: "QFD Bushfire Prone Area",
  sa_pdcode_hazards_bushfire: "SA Code Hazards (Bushfire)",
  wa_obrm_026_bpa: "WA Bush Fire Prone Areas",
  tas_tps_bushfire_prone: "TPS Bushfire-prone Areas",
  act_bpa_2026: "ACT Bushfire Prone Area 2026",
  // Retired id: rows loaded before the VIC switch to the BPA carry it until
  // the next -mode hazards load. Kept so the web can deploy first.
  vic_plan_overlay_bmo: "Vicmap BMO",
};

function sourceLabel(id: string): string | undefined {
  return SOURCE_LABELS[id];
}
