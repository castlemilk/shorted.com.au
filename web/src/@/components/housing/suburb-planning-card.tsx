// NO "use client" — rendered inside the server-side suburb profile body. Pure
// props in, markup out: no hooks, no Connect imports. Colours and labels are
// looked up from serializable registries, never passed as functions.
import Link from "next/link";
import type { SuburbPlanning } from "~/gen/shorts/v1alpha1/housing_pb";
import { overlayAvailable } from "@/lib/housing/overlays";
import {
  HERITAGE_ITEM_NOTES,
  PLANNING_SOURCE_CREDITS,
  planningCreditIds,
  planningView,
} from "@/lib/housing/planning-sources";
import { STATE_NAMES, stateSlug } from "@/lib/housing/states";
import { ZONE_FAMILY_COLORS, ZONE_FAMILY_LABELS, isZoneFamily } from "@/lib/housing/zone-families";
import { HousingIcon } from "./housing-icon";
import { fmtShare } from "./suburb-hazard-card";

/**
 * Planning & zoning — what the statutory planning scheme says about the land
 * in this suburb: the zoning mix (grouped into ten families across states),
 * how much of it is a heritage area, and in NSW the development standards
 * (height, floor space ratio, minimum lot size) over its residential land.
 *
 * Absent values render nothing: QLD has heritage items but no statewide
 * zoning, and the development standards exist only for NSW. A measured 0
 * renders as 0. Two withheld cases are said rather than hidden: a suburb the
 * scheme layers reach for under half its area (only the coverage is stored),
 * and a NSW standard the LEP maps on under half the residential land (its
 * mapped share is stored, its value is not).
 */
export function SuburbPlanningCard({
  planning, stateCode, salCode,
}: {
  planning?: SuburbPlanning;
  stateCode: string;
  salCode: string;
}) {
  if (!planning) return null;
  // Repeated fields default to [] on a decoded message; `?? []` keeps a
  // hand-built or partially mocked one from crashing the whole profile.
  const shares = (planning.zoneShares ?? []).filter((z) => isZoneFamily(z.family) && z.sharePct > 0);
  const instruments = planning.instruments ?? [];
  const coverage = planning.zoningCoveragePct;
  const heritageShare = planning.heritageSharePct;
  const items = planning.heritageItemCount;
  const height = planning.nswHeightMedianM;
  const heightMax = planning.nswHeightMaxM;
  const fsr = planning.nswFsrMedian;
  const lot = planning.nswMinLotMedianM2;
  const view = planningView(planning);
  if (!view) return null;
  const hasZoning = shares.length > 0;
  const { partialOnly, hasHeritage, hasControls, withheldControls, controls } = view;
  if (!hasZoning && !partialOnly && !hasHeritage && !hasControls) return null;
  const mappedPct = (key: "height" | "fsr" | "lot") => controls.find((c) => c.key === key)?.mappedPct;

  const stateName = STATE_NAMES[stateCode] ?? stateCode;
  const mapHref = (overlay: "zoning" | "heritage") =>
    `/housing/${stateSlug(stateCode)}?sal=${salCode}&overlays=${overlay}`;
  const sources = planningCreditIds(planning)
    .map((id) => PLANNING_SOURCE_CREDITS[id]?.short)
    .filter(Boolean);

  return (
    <section aria-labelledby="planning-heading">
      <h2 id="planning-heading" className="mb-3 flex items-center gap-2.5 font-serif text-2xl text-foreground">
        <HousingIcon name="council" size={26} /> Planning &amp; zoning
      </h2>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {hasZoning ? (
          <div className="border-b border-border px-3.5 py-3">
            <div className="flex items-baseline justify-between gap-2">
              <div className="text-[11px] text-muted-foreground">Zoning mix (share of the suburb&apos;s land)</div>
              {overlayAvailable("zoning", stateCode) ? (
                <Link href={mapHref("zoning")} className="shrink-0 text-[11px] text-primary transition-colors hover:text-foreground">
                  Show on map →
                </Link>
              ) : null}
            </div>
            <div
              role="img"
              aria-label={`Zoning mix: ${shares.map((z) => `${ZONE_FAMILY_LABELS[z.family as keyof typeof ZONE_FAMILY_LABELS]} ${fmtShare(z.sharePct)}`).join(", ")}`}
              className="mt-2 flex h-3 w-full overflow-hidden rounded-full bg-muted"
            >
              {shares.map((z) => (
                <span
                  key={z.family}
                  data-family={z.family}
                  className="h-full"
                  style={{ width: `${z.sharePct}%`, background: ZONE_FAMILY_COLORS[z.family as keyof typeof ZONE_FAMILY_COLORS] }}
                />
              ))}
            </div>
            <ul className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
              {shares.map((z) => (
                <li key={z.family} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ background: ZONE_FAMILY_COLORS[z.family as keyof typeof ZONE_FAMILY_COLORS] }}
                  />
                  <span className="min-w-0 flex-1 truncate">{ZONE_FAMILY_LABELS[z.family as keyof typeof ZONE_FAMILY_LABELS]}</span>
                  <span className="font-mono tabular-nums text-foreground">{fmtShare(z.sharePct)}</span>
                </li>
              ))}
            </ul>
            {coverage !== undefined && coverage < 99.5 ? (
              <p className="mt-2 text-[10px] text-muted-foreground">
                {fmtShare(100 - coverage)} of the suburb sits outside any mapped zone (typically unzoned roads,
                water or land outside the scheme), so the shares add up to {fmtShare(coverage)}.
              </p>
            ) : null}
          </div>
        ) : null}
        {partialOnly && coverage !== undefined ? (
          <p className="border-b border-border px-3.5 py-3 text-[11px] text-muted-foreground [text-wrap:pretty]">
            The statewide zoning map covers only {fmtShare(coverage)} of this suburb; the rest is planned under an
            instrument that map does not carry, so no zoning mix or heritage figure is given for it.
          </p>
        ) : null}
        {hasHeritage || hasControls ? (
          <div className="-mb-px -mr-px grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
            {heritageShare !== undefined ? (
              <Tile label="In a heritage area" value={fmtShare(heritageShare)}
                note="conservation area / Heritage Overlay"
                href={overlayAvailable("heritage", stateCode) ? mapHref("heritage") : undefined} />
            ) : null}
            {items !== undefined ? (
              <Tile label="Listed heritage places" value={items.toLocaleString("en-AU")}
                note={HERITAGE_ITEM_NOTES[planning.heritageSource] ?? "individually listed items"} />
            ) : null}
            {height !== undefined ? (
              <Tile label="Max building height" value={fmtMetres(height)}
                note={heightMax !== undefined && heightMax > height ? `typical; up to ${fmtMetres(heightMax)}` : "typical, residential land"}
                basis={mappedBasis(mappedPct("height"))} />
            ) : null}
            {fsr !== undefined ? (
              <Tile label="Floor space ratio" value={`${fmtRatio(fsr)}:1`} note="floor area allowed per m² of site"
                basis={mappedBasis(mappedPct("fsr"))} />
            ) : null}
            {lot !== undefined ? (
              <Tile label="Minimum lot size" value={fmtLot(lot)} note="to subdivide residential land"
                basis={mappedBasis(mappedPct("lot"))} />
            ) : null}
          </div>
        ) : null}
      </div>
      <p className="mt-2.5 text-[11px] text-muted-foreground [text-wrap:pretty]">
        {instruments.length ? <>Planning instrument{instruments.length > 1 ? "s" : ""}: {instruments.join("; ")}. </> : null}
        Zones are grouped into ten families so states compare; the council&apos;s own scheme is the authority for any one lot.
        {hasControls ? " Height, floor space ratio and lot size are the NSW Local Environmental Plan standards: the area-weighted median over the residential-zoned land where the LEP maps that standard, given only where it maps it on at least half of that land; clause-based exceptions are not modelled." : ""}
        {withheldControls.length
          ? ` Not given because the LEP maps ${withheldControls.length > 1 ? "them" : "it"} on under half of the suburb's residential land (usually only its centres): ${withheldControls
              .map((c) => `${c.label} (${fmtShare(c.mappedPct ?? 0)})`)
              .join(", ")}.`
          : ""}
        {items !== undefined ? " Listed-place counts follow each state's own list, so they do not compare across states." : ""}
        {!hasZoning && stateCode === "QLD" ? ` ${stateName} has no statewide zoning map — each council publishes its own.` : ""}
        {sources.length ? ` Source: ${sources.join("; ")}.` : ""}
      </p>
    </section>
  );
}

/** "mapped on 64% of residential land" — only when the standard is not mapped on (nearly) all of it. */
function mappedBasis(pct: number | undefined): string | undefined {
  return pct !== undefined && pct < 95 ? `mapped on ${fmtShare(pct)} of residential land` : undefined;
}

function Tile({ label, value, note, basis, href }: { label: string; value: string; note?: string; basis?: string; href?: string }) {
  return (
    <article aria-label={label} className="flex flex-col gap-0.5 border-b border-r border-border px-3 py-3 sm:px-3.5">
      <div className="text-[11px] leading-tight text-muted-foreground">{label}</div>
      <div className="font-mono text-[15px] font-semibold tabular-nums text-foreground">{value}</div>
      {note ? <div className="text-[10px] text-muted-foreground">{note}</div> : null}
      {basis ? <div className="text-[10px] text-muted-foreground">{basis}</div> : null}
      {href ? (
        <Link href={href} className="mt-0.5 inline-block text-[11px] text-primary transition-colors hover:text-foreground">
          Show on map →
        </Link>
      ) : null}
    </article>
  );
}

export function fmtMetres(v: number): string {
  return `${Number.isInteger(v) ? v : v.toFixed(1)} m`;
}

export function fmtRatio(v: number): string {
  return v >= 10 ? v.toFixed(0) : v.toFixed(v % 1 === 0 ? 0 : 2).replace(/0$/, "");
}

export function fmtLot(m2: number): string {
  if (m2 >= 10_000) {
    const ha = m2 / 10_000;
    return `${Number.isInteger(ha) ? ha : ha.toFixed(1)} ha`;
  }
  return `${Math.round(m2).toLocaleString("en-AU")} m²`;
}
