/**
 * The 14 items of the Register of Members'/Senators' Interests, as a compact tag.
 *
 * This is the SOURCE'S OWN taxonomy, not one we invented — the form asks for
 * exactly these fourteen things in this order. Using it means a reader can take
 * any row on a profile back to the numbered item on the original PDF.
 *
 * WHY A SHORT LABEL: the long labels are the form's legal wording ("Family and
 * business trusts and nominee companies", "Bonds, debentures and like
 * investments"). They are accurate and unreadable in a dense table, so the long
 * form is kept as the tooltip and the short form is what renders.
 *
 * ICONOGRAPHY IS GOVERNED BY THE EDITORIAL STANDARDS, not by taste.
 * docs/influence-editorial-standards.md rule 2 covers iconography beside a named
 * person and rule 5 forbids stating or implying value. So:
 *
 *   - NO currency glyphs. Item 10 is "other substantial sources of income" and
 *     a money-bag beside a named MP implies an amount the register does not
 *     disclose. It gets an inbox tray: the category is "income received", and
 *     that is all the icon may say.
 *   - NO warning, alert or judgement glyphs (no red, no sirens, no eyes). An
 *     icon that reads as a flag next to a person is an accusation, which is
 *     exactly what rule 2 exists to prevent.
 *   - Every icon is DESCRIPTIVE of the category and evaluative of nothing.
 *
 * register-items.test.ts enforces the first two by inspecting the glyphs, so
 * this survives someone later reaching for a more expressive emoji.
 */

export interface RegisterItem {
  /** Decorative only — always rendered aria-hidden, with the label as the text. */
  emoji: string;
  /** What renders in a table cell. */
  label: string;
  /** The form's own wording, used as the tooltip. */
  formLabel: string;
}

export const REGISTER_ITEMS: Record<number, RegisterItem> = {
  1: {
    emoji: "📊",
    label: "Shareholdings",
    formLabel: "Shareholdings in public and private companies",
  },
  2: {
    emoji: "🗂️",
    label: "Trusts",
    formLabel: "Family and business trusts and nominee companies",
  },
  3: { emoji: "🏠", label: "Real estate", formLabel: "Real estate" },
  4: {
    emoji: "💼",
    label: "Directorship",
    formLabel: "Registered directorships of companies",
  },
  5: { emoji: "🤝", label: "Partnership", formLabel: "Partnerships" },
  6: { emoji: "🧾", label: "Liability", formLabel: "Liabilities" },
  7: {
    emoji: "📜",
    label: "Bonds",
    formLabel: "Bonds, debentures and like investments",
  },
  8: {
    emoji: "🏦",
    label: "Accounts",
    formLabel: "Savings or investment accounts",
  },
  9: { emoji: "📦", label: "Other assets", formLabel: "Other assets" },
  10: {
    emoji: "📥",
    label: "Other income",
    formLabel: "Other substantial sources of income",
  },
  11: { emoji: "🎁", label: "Gift", formLabel: "Gifts" },
  12: {
    emoji: "✈️",
    label: "Sponsored travel",
    formLabel: "Sponsored travel or hospitality",
  },
  13: {
    emoji: "🏛️",
    label: "Office held",
    formLabel: "Office holder or financial contributor",
  },
  14: { emoji: "📌", label: "Other interest", formLabel: "Other interests" },
};

/**
 * Look up an item, tolerating an unknown number.
 *
 * Returns undefined rather than a placeholder: a row whose item we cannot name
 * should render no tag at all. Inventing a category for it would be a claim
 * about what the member declared.
 */
export function registerItem(itemNo?: number): RegisterItem | undefined {
  if (!itemNo) return undefined;
  return REGISTER_ITEMS[itemNo];
}
