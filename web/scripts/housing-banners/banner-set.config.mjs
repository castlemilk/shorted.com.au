// Housing suburb-banner backgrounds — the archetype prompt config.
//
// Unlike the icons (transparent, single-subject), these are FULL-BLEED landscape
// SCENES used as the background layer of a suburb banner header. Each suburb is
// classified into one archetype (from real signals: coast distance, amenity +
// population density, parks, remoteness), so a small reusable library of scenes
// covers all ~15k suburbs — the per-suburb uniqueness comes from the vector map
// snapshot + name + blurb composited ON TOP (see the banner design spec).
//
// Style is a warm editorial duotone landscape illustration — the scene-scale
// sibling of the housing icon system, so banners and icons read as one brand.

export const STYLE = {
  // Appended to every archetype's subject prompt.
  suffix:
    "Wide flat editorial illustration in a warm duotone palette — warm amber (#FFA94D) and " +
    "muted sage-olive (#87A96B) with small clay-rust (#D16A47) accents, over a soft warm-cream " +
    "sky, grounded by a deep charcoal-brown. Layered screen-print poster style with gentle paper " +
    "grain, simple bold shapes, a clean low horizon and soft directional golden light. Keep the " +
    "upper third a calm, near-empty sky for overlaid text; weight the scenery to the lower " +
    "two-thirds. Full-bleed landscape scene, no transparency. No text, no letters, no numbers, no " +
    "people, no logos. No photorealism, no 3D render, no harsh detail, no frame or border. " +
    "Cohesive header set, uniform mood and palette across every archetype.",
  palette: ["#FFA94D", "#87A96B", "#D16A47"],
  themeStyle: "warm editorial duotone flat landscape illustration, screen-print poster",
  globalRules: [
    "warm editorial duotone landscape",
    "amber #FFA94D + sage-olive #87A96B primary, clay-rust #D16A47 accent, warm-cream sky",
    "flat layered screen-print poster style with subtle paper grain",
    "simple bold shapes, clean low horizon, soft golden directional light",
    "calm near-empty sky in the upper third reserved for overlaid text",
    "full-bleed landscape scene, scenery weighted to the lower two-thirds",
    "cohesive header set, uniform mood and palette",
  ],
  negativeConstraints: [
    "text", "letters", "numbers", "words", "people", "faces", "logos", "watermark",
    "photorealism", "3D render", "harsh detail", "frame", "border",
  ],
};

/**
 * The archetype background set. `id` is the stable key (kebab-case) that a
 * suburb's classified archetype maps to. `subject` is the scene; the final prompt
 * is `${subject}. ${STYLE.suffix}`. `signal` documents which data drives it.
 */
export const ARCHETYPES = [
  { id: "coastal-beach", signal: "coast_km < ~2, open ocean", subject: "a calm Australian surf beach with pale sand dunes, a gently curling shoreline and a distant rocky headland" },
  { id: "harbour", signal: "coast_km small, sheltered water / high density coastal", subject: "a sheltered harbour bay with a few small moored boats, a timber jetty and low green hills wrapping behind" },
  { id: "river-valley", signal: "inland waterway / river suburb", subject: "a slow winding river threading through a green valley lined with tall gum trees and reed banks" },
  { id: "urban-skyline", signal: "high population + amenity density, inner-city", subject: "a compact city skyline of simple tower silhouettes at golden hour with layered lower rooftops in front" },
  { id: "inner-terraces", signal: "dense inner suburb, older housing", subject: "a tight row of Victorian terrace-house rooftops with chimneys and leafy street trees between them" },
  { id: "leafy-suburban", signal: "mid-density suburban, high greenery", subject: "detached suburban houses nestled among large shady trees beside a small neighbourhood park" },
  { id: "parkland", signal: "very high parks count", subject: "open rolling parkland with scattered round shade trees, a winding footpath and a calm reflective pond" },
  { id: "hills-ranges", signal: "elevated / rural-urban fringe", subject: "rolling green hills stepping up to a low blue mountain range under a wide open sky" },
  { id: "bushland", signal: "remote, far from coast, low density", subject: "dry eucalypt bushland with slender gum trees, low scrub and distant hazy blue ridgelines" },
  { id: "farmland", signal: "rural, far inland, agricultural", subject: "a patchwork of rural farmland fields with a lone windmill, a fence line and a distant grain silo" },
];

export const ARCHETYPE_IDS = ARCHETYPES.map((a) => a.id);
