/**
 * The fourteen register items → the politics icon set.
 *
 * `@/lib/politics/register-items` holds the taxonomy (label, the form's own
 * wording, and the emoji that shipped first). This module holds the SPRITE id
 * for each item, kept separate for two reasons:
 *
 *   - the emoji tag and the sprite icon are different renderings of the same
 *     taxonomy, and a surface may reasonably use either; and
 *   - `register-items.ts` is imported by the operator console and by tests that
 *     assert its glyphs, so it stays free of any dependency on a generated
 *     manifest.
 *
 * THE SAME BANS APPLY TO BOTH. The subjects behind these ids carry no money, no
 * warning mark, no gavel or scales and no trophy — see the header of
 * `web/scripts/politics-icons/icon-set.config.mjs`. Item 10 ("other substantial
 * sources of income") maps to an INBOX TRAY for exactly the reason it carries
 * 📥 today: the register discloses that income was received and never how much,
 * so that is the whole of what the icon may say.
 *
 * The map is TOTAL over items 1–14 and a test asserts it stays that way; a new
 * item would need an icon generated for it, not a fallback.
 */

import type { PoliticsIconName } from "@/components/politicians/politics-icons.generated";

export const REGISTER_ITEM_ICON: Record<number, PoliticsIconName> = {
  1: "shareholdings",
  2: "trusts",
  3: "real-estate",
  4: "directorships",
  5: "partnerships",
  6: "liabilities",
  7: "bonds",
  8: "accounts",
  9: "other-assets",
  10: "other-income",
  11: "gifts",
  12: "sponsored-travel",
  13: "office-held",
  14: "other-interests",
};

/**
 * Look up an item's icon, tolerating an unknown number.
 *
 * Returns undefined rather than a placeholder, exactly as `registerItem` does: a
 * row whose item we cannot name should render no icon at all. A generic
 * fallback glyph beside a named member is a category we invented.
 */
export function registerItemIcon(itemNo?: number): PoliticsIconName | undefined {
  if (!itemNo) return undefined;
  return REGISTER_ITEM_ICON[itemNo];
}

/**
 * The five AEC receipt-type buckets → the funding icons.
 *
 * Keys are the `ReceiptTypeKey` union in `@/lib/politics/funding-money`, which
 * is the vocabulary every funding surface already renders in.
 */
export const RECEIPT_TYPE_ICON: Record<string, PoliticsIconName> = {
  donation: "donation-receipt",
  otherReceipt: "other-receipt",
  subscription: "subscription",
  publicFunding: "public-funding",
  unspecified: "unspecified-receipt",
};

/** The three holder kinds → the holder icons. */
export const HOLDER_ICON: Record<string, PoliticsIconName> = {
  self: "holder-self",
  spouse: "holder-spouse",
  dependent: "holder-dependent",
};
