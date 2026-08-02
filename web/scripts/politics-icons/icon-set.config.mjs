// Politics iconography — the per-component prompt config (inputs to generation).
//
// Each icon is a concept-specific `subject`; the final prompt sent to the image
// model is `${subject}. ${STYLE.suffix}`. STYLE is copied VERBATIM from the
// housing icon set (web/scripts/housing-icons/icon-set.config.mjs), via the
// economy set (web/scripts/economy-icons/icon-set.config.mjs), so all three read
// as ONE system and a politician surface can sit beside a housing or economy one
// without a style clash.
//
// ---------------------------------------------------------------------------
// THE SUBJECTS ARE AN EDITORIAL ARTEFACT, NOT A STYLE CHOICE.
// ---------------------------------------------------------------------------
// docs/influence-editorial-standards.md rule 1 names ICONOGRAPHY as one of the
// four ways a page of true facts can still carry a defamatory imputation
// (headline, juxtaposition, iconography, selective emphasis). Rule 5 forbids
// stating or implying the value of a declared holding. These icons render beside
// NAMED parliamentarians, so the subject wording is bound by both:
//
//   - NO money. No money bag, no coin, no banknote, no dollar sign, no cash, no
//     till. The Registers of Members'/Senators' Interests record WHAT is held
//     and never how much, so a money glyph beside a declaration invents a figure
//     the source does not disclose. Item 10 is "other substantial sources of
//     income" and it gets an INBOX TRAY — matching the existing 📥 precedent in
//     `@/lib/politics/register-items` — because "income received" is the whole
//     of what the icon is permitted to say.
//   - NO warning, alert or judgement glyphs. No exclamation, no siren, no
//     warning triangle, no red flag, no eye, no detective, no surveillance.
//     An icon that reads as a flag beside a person is an accusation.
//   - NO legal-process or verdict glyphs. No gavel, no scales of justice, no
//     courthouse, no handcuffs. Every entry in these registers is a LAWFUL,
//     DISCLOSED fact; dressing it in the furniture of a trial is the imputation
//     rule 2 exists to prevent.
//   - NO winner/loser glyphs. No trophy, no medal, no podium, no crown, no
//     thumbs. Ranking a member's declarations as a victory (or a defeat) is a
//     judgement about a disclosure.
//
// Every subject is DESCRIPTIVE of the category and evaluative of nothing — the
// same contract `register-items.test.ts` already enforces on the emoji. The
// vocabulary is enforced by `politics-icon-subjects.test.ts`, which reads THIS
// FILE, so it survives someone later reaching for a more expressive subject.
//
// Generation: the DIRECT OpenAI path (generate-icons-openai.mjs, gpt-image-1
// Images API) is the proven route. pack-sprite.mjs packs out/<id>.png into
// public/politics-icons/politics-icons.png + a typed manifest.

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
    // The editorial negatives. They are in the PROMPT as well as in the review,
    // because the model will happily decorate a parcel with a currency symbol if
    // nothing tells it not to — and one did, on the first pass at `gifts`.
    "money", "coins", "banknotes", "currency symbol", "dollar sign", "price tag",
    "warning sign", "exclamation mark", "red alert", "gavel", "scales of justice",
    "trophy", "medal", "crown",
  ],
};

/**
 * The politics icon set. `id` is the stable key used by the manifest +
 * <PoliticsIcon>. `group` organises the sprite/manifest only. Keep ids
 * kebab-case.
 *
 * The `register` ids map 1:1 to the fourteen numbered items of the Register of
 * Members'/Senators' Interests; `@/lib/politics/register-item-icons` holds that
 * mapping and a test asserts it stays total.
 */
export const ICONS = [
  // --- register: the form's own fourteen items, in the form's own order ---
  { id: "shareholdings", group: "register", subject: "a share certificate document beside a ruled ledger page" },
  { id: "trusts", group: "register", subject: "a rolled legal deed tied with a ribbon, beside a small stone keystone block" },
  { id: "real-estate", group: "register", subject: "a simple house beside a rolled property deed" },
  { id: "directorships", group: "register", subject: "an oval boardroom table seen from above with simple chairs around it" },
  // Tightened on the first review pass: "two round wax seal discs overlapping
  // and interlocking" came back as two shapeless blobs. Naming the rim and the
  // centre is what makes them read as seals.
  { id: "partnerships", group: "register", subject: "two plain circular document seals side by side, overlapping at their edges, each a flat disc with a scalloped rim and a clear centre" },
  // Tightened on the first review pass: "one ruled line across it" produced a
  // blank card with a dot. A note needs ruled text and a signature line to read
  // as a note at all.
  { id: "liabilities", group: "register", subject: "a promissory note document with several ruled text lines and a long blank signature line across its foot" },
  { id: "bonds", group: "register", subject: "an unrolled certificate scroll with a ribbon at its foot" },
  { id: "accounts", group: "register", subject: "a small bank passbook opened to a ruled page" },
  { id: "other-assets", group: "register", subject: "a lidded archive storage box with a blank label card" },
  // Item 10 is "other substantial sources of income". An inbox tray, never a
  // money glyph — see the header. This matches the existing 📥 precedent.
  { id: "other-income", group: "register", subject: "an open inbox tray with a single sheet of paper resting in it" },
  { id: "gifts", group: "register", subject: "a plain wrapped parcel tied with a ribbon bow, the wrapping completely blank" },
  { id: "sponsored-travel", group: "register", subject: "an aeroplane beside a plain torn boarding ticket stub" },
  { id: "office-held", group: "register", subject: "a speaker's lectern beside a small triangular club pennant on a short pole" },
  { id: "other-interests", group: "register", subject: "a plain document folder with a paper tab" },

  // --- holder: whose interest a row records (self / spouse / dependent) ---
  { id: "holder-self", group: "holder", subject: "a single simple abstract person figure" },
  { id: "holder-spouse", group: "holder", subject: "two simple abstract person figures standing side by side" },
  { id: "holder-dependent", group: "holder", subject: "a small simple abstract person figure standing beside a taller one" },

  // --- funding: the AEC Transparency Register's five receipt types ---
  { id: "donation-receipt", group: "funding", subject: "a plain sealed parcel being lowered into an open tray" },
  { id: "other-receipt", group: "funding", subject: "a long paper receipt slip with three ruled lines and a torn lower edge" },
  { id: "subscription", group: "funding", subject: "a plain rounded membership card with a small blank strip" },
  { id: "public-funding", group: "funding", subject: "a ballot box with a folded slip going into its slot" },
  { id: "unspecified-receipt", group: "funding", subject: "a blank sheet of paper with one folded corner" },

  // --- activity: what changed, and what we can see ---
  { id: "entry-added", group: "activity", subject: "a sheet of paper sliding into an open folder, with a small arrow pointing in" },
  { id: "entry-removed", group: "activity", subject: "a sheet of paper sliding out of an open folder, with a small arrow pointing out" },
  { id: "coverage", group: "activity", subject: "an open ledger book lying flat with ruled pages" },
  // Tightened TWICE. "a round wax seal" came back as a circular medallion with
  // two ribbon tails — which reads as a MEDAL, and the set bans winner imagery
  // beside a named member. Saying "no ribbon and no tails" did not shift it: the
  // model keeps the ribbon whenever the seal is round. So the seal is gone
  // entirely, replaced by a RECTANGULAR ink stamp, which cannot be mistaken for
  // an award and says the one thing the icon needs to say — this is the filed
  // document. A negative in a prompt is a hint; changing the shape is a fix.
  { id: "source-document", group: "activity", subject: "a single document page with a small rectangular ink date stamp mark in its lower corner" },
  { id: "compare", group: "activity", subject: "two plain rounded rectangular panels standing side by side" },

  // --- ui: interface accents, never rendered beside a named person ---
  // The magnifier is the universal SEARCH affordance in a toolbar. It is listed
  // here, and constrained to the search box, precisely because a magnifier
  // pointed at a person reads as investigation — which is why the set carries no
  // detective, eye, binocular or surveillance subject at all.
  { id: "search", group: "ui", subject: "a plain magnifying glass with a short handle" },
  { id: "timeline", group: "ui", subject: "a horizontal line with three evenly spaced round markers along it" },
  { id: "electorate", group: "ui", subject: "a rounded map location pin standing on a simple map outline" },
  { id: "parliament", group: "ui", subject: "a classical parliament building with a low central dome and columns" },
];

export const ICON_IDS = ICONS.map((i) => i.id);

/** The groups the set is organised into, in sprite order. */
export const ICON_GROUPS = ["register", "holder", "funding", "activity", "ui"];
