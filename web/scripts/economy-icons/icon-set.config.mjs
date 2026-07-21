// Economy iconography — the per-component prompt config (inputs to generation).
//
// Each icon is a concept-specific `subject`; the final prompt sent to the image
// model is `${subject}. ${STYLE.suffix}`. STYLE is copied VERBATIM from the
// housing icon set (web/scripts/housing-icons/icon-set.config.mjs) so the
// economy icons share the exact same warm-duotone visual system and sit
// alongside housing icons without a style clash.
//
// Generation: the DIRECT OpenAI path (generate-icons-openai.mjs, gpt-image-1
// Images API) is the proven route; a flow-orchestrator MCP clone
// (generate-icons.mjs) exists as an alternative. pack-sprite.mjs packs
// out/<id>.png into public/economy-icons/economy-icons.png + a typed manifest.

export const STYLE = {
  // Appended to every icon's subject prompt — VERBATIM from housing-icons.
  suffix:
    "Minimal flat vector icon in a warm editorial duotone style. Two main colours — warm amber " +
    "(#FFA94D) and muted sage-olive (#87A96B) — with a small clay-rust (#D16A47) accent, and a " +
    "dark charcoal-brown outline. Bold clean geometric shapes, consistent medium stroke weight, " +
    "gently rounded corners. Single centred subject, generous even padding, no scene. Fully " +
    "transparent background. No text, no letters, no numbers. No drop shadow, no gradient, no " +
    "photorealism, no 3D, no frame or border. Cohesive icon-set look, uniform visual weight, 1:1 square.",
  palette: ["#FFA94D", "#87A96B", "#D16A47"],
  themeStyle: "warm editorial duotone flat icon",
  globalRules: [
    "warm editorial duotone",
    "amber #FFA94D + sage-olive #87A96B primary, clay-rust #D16A47 accent",
    "dark charcoal-brown outline, consistent medium stroke weight, rounded corners",
    "single centred subject, generous even padding",
    "fully transparent background",
    "cohesive icon set, uniform visual weight",
  ],
  negativeConstraints: [
    "text", "letters", "numbers", "words", "drop shadow", "gradient",
    "photorealism", "3D render", "background fill", "frame", "border", "watermark",
  ],
};

/**
 * The economy icon set. `id` is the stable key used by the manifest +
 * <EconomyIcon>. `group` organises the sprite/manifest only. Keep ids kebab-case.
 *
 * The commodity ids map 1:1 to the SITC single-digit sections used by
 * TopExports / SITC_PRODUCTS in top-exports.tsx.
 */
export const ICONS = [
  // --- headers: rates / prices / labour ---
  { id: "cash-rate", group: "macro", subject: "a classical bank building with columns and a bold percent symbol beside it" },
  { id: "cpi", group: "macro", subject: "a round price tag next to a semicircular gauge dial with a needle" },
  { id: "unemployment", group: "macro", subject: "a single person figure standing beside a briefcase" },
  { id: "participation", group: "macro", subject: "a compact cluster of three simple people figures standing together" },
  { id: "aud-usd", group: "macro", subject: "two coins side by side, one marked as a currency the other blank, with a small exchange arrow between them" },
  // --- headers: geography / trade / energy ---
  { id: "sfd", group: "state", subject: "a simple state map outline with three small vertical bars rising inside it" },
  { id: "exports", group: "trade", subject: "a cargo ship with an arrow pointing outward to the right" },
  { id: "imports", group: "trade", subject: "a cargo ship with an arrow pointing inward to the left" },
  { id: "trade-balance", group: "trade", subject: "a balanced two-pan weighing scale" },
  { id: "diesel", group: "energy", subject: "a fuel pump with a nozzle and hose" },
  { id: "refinery", group: "energy", subject: "a group of tall refinery distillation towers with connecting pipes" },
  // --- headers: markets / companies / finances ---
  { id: "company-footprint", group: "markets", subject: "a small cluster of office buildings sitting on top of a rounded map location pin" },
  { id: "short-interest", group: "markets", subject: "a single downward-pointing candlestick chart bar with a falling arrow" },
  { id: "state-finances", group: "markets", subject: "a government building with a dome beside an open ledger book" },
  // --- commodities: SITC single-digit sections ---
  { id: "food", group: "commodities", subject: "a bundle of wheat stalks beside a small cow silhouette" },
  { id: "beverages-tobacco", group: "commodities", subject: "a drink bottle beside a smoking pipe" },
  { id: "crude-materials", group: "commodities", subject: "a few rough chunks of raw ore or mineral rock" },
  { id: "mineral-fuels", group: "commodities", subject: "a lump of coal beside a gas flame" },
  { id: "oils-fats", group: "commodities", subject: "an oil droplet falling from a small tilted jug" },
  { id: "chemicals", group: "commodities", subject: "a laboratory conical flask with a bubbling liquid" },
  { id: "manufactured-goods", group: "commodities", subject: "a stack of sealed cardboard shipping boxes" },
  { id: "machinery-transport", group: "commodities", subject: "a mechanical gear cog beside a simple delivery truck" },
  { id: "misc-manufactures", group: "commodities", subject: "an assortment of small manufactured objects grouped together" },
  { id: "other-commodities", group: "commodities", subject: "a shipping crate with a small tag attached" },
];

export const ICON_IDS = ICONS.map((i) => i.id);
