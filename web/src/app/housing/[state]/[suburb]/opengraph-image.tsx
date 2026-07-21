import { ImageResponse } from "next/og";
import { getSuburbProfile, resolveSuburbSalCode } from "~/app/actions/getHousing";
import { STATE_NAMES, slugToState } from "@/lib/housing/states";
import { fmtPriceShort } from "@/lib/housing/price-scale";

export const alt = "Suburb House Prices & Demographics — Shorted.com.au";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
// nodejs (not edge) so the profile fetch below can use the same Connect-RPC
// server actions the page uses.
export const runtime = "nodejs";
// Regenerate daily — matches the page's own revalidate, so a later-arriving
// median price / archetype (or a transient RPC failure) doesn't freeze into
// the card for a full year (same rationale as the stock OG route).
export const revalidate = 86400;

/** kebab-slug -> Title Case, dropping a trailing postcode segment (e.g.
 * "bondi-beach-2026" -> "Bondi Beach"). This is the guaranteed fallback name
 * — it needs no DB access, so it renders even against an empty local DB. */
function titleCase(slug: string): string {
  const parts = slug.split("-").filter(Boolean);
  if (parts.length > 1 && /^\d{3,4}$/.test(parts[parts.length - 1] ?? "")) {
    parts.pop();
  }
  return parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export default async function Image({
  params,
}: {
  params: Promise<{ state: string; suburb: string }>;
}) {
  const { state, suburb } = await params;

  let name = titleCase(suburb);
  let stateName = "";
  let archetype = "leafy-suburban";
  let priceLabel: string | undefined;

  // Best-effort enrichment. The local DB is empty and prod must never 500 on
  // a crawler/share fetch, so any failure here just falls back to the
  // slug-derived name + defaults above.
  try {
    const code = slugToState(state);
    if (code) {
      stateName = STATE_NAMES[code] ?? code;
      const sal = await resolveSuburbSalCode(code, suburb);
      if (sal) {
        // withRetryAndNotFound swallows all errors as `undefined` rather than
        // throwing — guard explicitly rather than relying on the catch below.
        const profile = await getSuburbProfile(sal);
        if (profile?.summary?.salName) name = profile.summary.salName;
        if (profile?.banner?.archetype) archetype = profile.banner.archetype;
        if (profile?.summary && profile.summary.latestMedianPrice > 0) {
          priceLabel = fmtPriceShort(profile.summary.latestMedianPrice);
        }
      }
    }
  } catch (err) {
    console.error(`[opengraph-image] suburb profile fetch failed for ${state}/${suburb}:`, err);
  }

  const archetypeLabel = titleCase(archetype);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: "#0C0C0C",
          // satori (next/og) doesn't parse sized radial-gradients — a linear
          // amber-to-near-black glow reads as the same warm brand bloom safely.
          backgroundImage:
            "linear-gradient(150deg, rgba(255,169,77,0.20) 0%, rgba(12,12,12,0) 55%)",
          padding: "64px 72px",
          color: "#E8DDB5",
          fontFamily: "Georgia, serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            fontFamily: "monospace",
            fontSize: 22,
            letterSpacing: 6,
            textTransform: "uppercase",
            color: "#FFA94D",
          }}
        >
          Shorted · Housing
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex" }}>
            <span style={{ fontSize: 104, lineHeight: 1.02, fontWeight: 600, color: "#F3EAC8" }}>
              {name}
            </span>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              fontFamily: "monospace",
              fontSize: 28,
              color: "#B7A98A",
            }}
          >
            {stateName ? <span>{stateName}</span> : null}
            {stateName ? <span style={{ color: "#6b5530" }}>·</span> : null}
            <span>{archetypeLabel}</span>
            {priceLabel ? <span style={{ color: "#6b5530" }}>·</span> : null}
            {priceLabel ? <span style={{ color: "#FFA94D", fontWeight: 700 }}>{priceLabel} median</span> : null}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTop: "2px solid rgba(255,169,77,0.5)",
            paddingTop: 24,
            fontFamily: "monospace",
            fontSize: 22,
            color: "#9C8F72",
          }}
        >
          <span>shorted.com.au</span>
          <span>House prices &amp; demographics</span>
        </div>
      </div>
    ),
    { ...size },
  );
}
