// Housing iconography — the per-component prompt config (inputs to the flow).
//
// Each icon is a concept-specific `subject`; the final prompt sent to the image
// model is `${subject}. ${STYLE.suffix}`. The shared STYLE (palette + rules +
// negatives) is also attached to a `style` node in the brandbrain flow graph, so
// every icon in the set shares one visual system. See generate-icons.mjs.
//
// Style was locked from a 4-icon live probe (2026-07-02): warm amber/olive/rust
// duotone + a dark editorial outline, flat, transparent, no text — reads on both
// the warm-white and terminal-black themes and stays legible at ~40px.

export const STYLE = {
  // Appended to every icon's subject prompt.
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
 * The icon set. `id` is the stable key used by the manifest + <HousingIcon>.
 * `group` is for organising the sprite/manifest only. Keep ids kebab-case.
 */
export const ICONS = [
  // --- finance ---
  { id: "median-price", group: "finance", subject: "a simple house with a small round price tag hanging from the eaves" },
  { id: "income", group: "finance", subject: "an open wallet with a single coin" },
  { id: "rent", group: "finance", subject: "a house with a key beside it" },
  { id: "mortgage", group: "finance", subject: "a classical bank building with columns and a coin" },
  { id: "debt", group: "finance", subject: "a balance scale weighing a coin against a small house" },
  { id: "price-index", group: "finance", subject: "an upward-trending bar chart with a rising arrow" },
  // --- people ---
  { id: "population", group: "people", subject: "a compact cluster of three simple people figures" },
  { id: "age", group: "people", subject: "a single person figure beside an hourglass" },
  { id: "dwellings", group: "people", subject: "a small cluster of house rooftops of different heights" },
  // --- culture ---
  { id: "religion", group: "culture", subject: "a stylised place of worship with a dome and a spire side by side" },
  { id: "language", group: "culture", subject: "two overlapping speech bubbles" },
  { id: "born-overseas", group: "culture", subject: "a globe with a small airplane arcing around it" },
  { id: "culture", group: "culture", subject: "two hands forming a heart shape" },
  // --- electoral ---
  { id: "representation", group: "electoral", subject: "a classical parliament building with a flag on top" },
  { id: "party", group: "electoral", subject: "a ballot box with a folded ballot slip going in" },
  { id: "federal-lean", group: "electoral", subject: "two arrows pointing left and right from a central point" },
  // --- amenities ---
  { id: "amenity-density", group: "amenities", subject: "a map location pin with small dots clustered around it" },
  { id: "supermarket", group: "amenities", subject: "a shopping trolley" },
  { id: "grocery", group: "amenities", subject: "a shopping basket filled with groceries" },
  { id: "pubs", group: "amenities", subject: "a frothy pint glass of beer" },
  { id: "parks", group: "amenities", subject: "a single leafy round tree" },
  { id: "libraries", group: "amenities", subject: "an open book" },
  // --- education ---
  { id: "school", group: "education", subject: "a graduation mortarboard cap" },
  // --- health ---
  { id: "healthcare", group: "health", subject: "a stethoscope" },
  { id: "hospital", group: "health", subject: "a hospital building marked with a bold medical cross" },
  { id: "pharmacy", group: "health", subject: "a mortar and pestle" },
  // --- transport / geography ---
  { id: "train", group: "transport", subject: "the front of a modern commuter train, head-on" },
  { id: "coast", group: "transport", subject: "a single curling ocean wave" },
  { id: "location", group: "transport", subject: "a single rounded map location pin" },
  { id: "city", group: "transport", subject: "a small city skyline of a few simple towers" },
  // --- infrastructure / civic ---
  { id: "nbn", group: "civic", subject: "a broadcast signal with concentric wifi waves" },
  { id: "council", group: "civic", subject: "a civic town hall building with a central clock" },
  { id: "grants", group: "civic", subject: "a hand holding up a coin" },
  // --- relationships ---
  { id: "compare", group: "relationships", subject: "two vertical bars of different heights side by side" },
  { id: "similar", group: "relationships", subject: "two overlapping circles like a venn diagram" },
  { id: "nearby", group: "relationships", subject: "a compass with a needle" },
  // --- archetype (banner badge; id === banner archetype id) ---
  { id: "coastal-beach", group: "archetype", subject: "a single curling ocean wave over a small sandy shore" },
  { id: "harbour", group: "archetype", subject: "a small sailboat beside a short timber jetty" },
  { id: "river-valley", group: "archetype", subject: "a winding river flowing between two banks" },
  { id: "urban-skyline", group: "archetype", subject: "three city tower blocks of increasing height side by side" },
  { id: "inner-terraces", group: "archetype", subject: "a row of three joined terrace-house rooftops with chimneys" },
  { id: "leafy-suburban", group: "archetype", subject: "a small pitched-roof house beside one round leafy tree" },
  { id: "parkland", group: "archetype", subject: "a round shade tree beside a simple park bench" },
  { id: "hills-ranges", group: "archetype", subject: "a simple twin-peak mountain range" },
  { id: "bushland", group: "archetype", subject: "a single slender eucalypt gum tree" },
  { id: "farmland", group: "archetype", subject: "a farm windmill beside a low fence" },
];

export const ICON_IDS = ICONS.map((i) => i.id);
