/**
 * The register's 14 items as a compact tag.
 *
 * The iconography assertions here are not style policing. Editorial rule 2
 * governs icons beside a named person and rule 5 forbids stating or implying
 * value, so a money-bag next to "other substantial sources of income" or a red
 * flag next to a gift would breach the standards the rest of this directory is
 * built to satisfy. Enforcing it by test means it survives someone later
 * reaching for a more expressive emoji.
 */

import { render, screen } from "@testing-library/react";

import { RegisterItemTag, SourceDocLink, registerDocLabel } from "../compliance";
import { REGISTER_ITEMS, registerItem } from "@/lib/politics/register-items";
import { REGISTER_ITEM_ICON } from "@/lib/politics/register-item-icons";
import { POLITICS_ICONS } from "../politics-icons.generated";

describe("register items", () => {
  it("covers all 14 form items exactly", () => {
    const nums = Object.keys(REGISTER_ITEMS).map(Number).sort((a, b) => a - b);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it("gives every item a distinct icon, so two categories never look alike", () => {
    const emojis = Object.values(REGISTER_ITEMS).map((i) => i.emoji);
    expect(new Set(emojis).size).toBe(emojis.length);
  });

  /** Rule 5: what is held, never how much. */
  it("uses no currency or money iconography", () => {
    const BANNED = ["💰", "💵", "💴", "💶", "💷", "🤑", "💸", "🪙", "💲", "$", "🏧"];
    for (const [no, item] of Object.entries(REGISTER_ITEMS)) {
      for (const glyph of BANNED) {
        expect(`item ${no}: ${item.emoji}`).not.toContain(glyph);
      }
    }
  });

  /** Rule 2: juxtaposition, not accusation — no icon may read as a flag. */
  it("uses no warning, alert or judgement iconography", () => {
    const BANNED = ["⚠️", "🚨", "🔴", "❗", "‼️", "🚩", "👀", "🕵️", "⛔", "❌", "🔥"];
    for (const [no, item] of Object.entries(REGISTER_ITEMS)) {
      for (const glyph of BANNED) {
        expect(`item ${no}: ${item.emoji}`).not.toContain(glyph);
      }
    }
  });

  it("states no quantity or value in any label", () => {
    for (const item of Object.values(REGISTER_ITEMS)) {
      expect(`${item.label} ${item.formLabel}`).not.toMatch(/[$€£]|\bworth\b|\bvalued\b|\bamount\b/i);
    }
  });

  it("keeps the form's own wording available for every item", () => {
    for (const item of Object.values(REGISTER_ITEMS)) {
      expect(item.formLabel.length).toBeGreaterThan(item.label.length - 1);
      expect(item.label.length).toBeLessThanOrEqual(16);
    }
  });

  /**
   * THE TAG RENDERS THE SPRITE ICON, NOT THE EMOJI.
   *
   * The emoji above is still the taxonomy's own glyph and the two BANNED-glyph
   * assertions above still police it — that is the data module's contract, and
   * the operator console reads it. What changed on 2026-08-02 is the RENDERING:
   * every reader-facing surface now draws the commissioned set, so this
   * assertion follows the tag rather than the taxonomy.
   *
   * The equivalent editorial gate on the ARTWORK is
   * `politics-icon-subjects.test.ts`, which reads the icon-set config and
   * enforces the same two bans on the subjects (no money, no warning, no gavel
   * or scales, no trophy) that the glyph assertions above enforce on the emoji.
   * Neither is redundant: one governs what the sprite depicts, the other what
   * `register-items.ts` still carries.
   */
  it("renders the category icon decoratively, with the label carrying the meaning", () => {
    const { container } = render(<RegisterItemTag itemNo={11} />);
    expect(screen.getByText("Gift")).toBeInTheDocument();

    const decorative = container.querySelector('[aria-hidden="true"]')!;
    // Decorative, so a screen reader hears "Gift" and not a description of a
    // wrapped parcel followed by "Gift".
    expect(decorative).toBeInTheDocument();
    expect(decorative.getAttribute("role")).toBeNull();
    expect(decorative.getAttribute("aria-label")).toBeNull();
    // It is the SPRITE, sliced at item 11's cell — not the emoji, and not a
    // separate network request per icon.
    expect((decorative as HTMLElement).style.backgroundImage).toContain(
      POLITICS_ICONS.sheet,
    );
    const gifts = POLITICS_ICONS.icons[REGISTER_ITEM_ICON[11]!];
    const scale = 14 / POLITICS_ICONS.cell;
    expect((decorative as HTMLElement).style.backgroundPosition).toBe(
      `-${gifts.x * scale}px -${gifts.y * scale}px`,
    );
    // And the emoji is no longer rendered anywhere in the tag.
    expect(container.textContent).not.toContain("🎁");

    // The form's legal wording is the tooltip — it is how a reader finds the
    // row on the original PDF.
    expect(container.firstElementChild?.getAttribute("title")).toBe("Gifts");
  });

  it("renders nothing for an item it cannot name, rather than inventing a category", () => {
    const { container } = render(<RegisterItemTag itemNo={99} />);
    expect(container).toBeEmptyDOMElement();
    expect(registerItem(undefined)).toBeUndefined();
    expect(registerItem(0)).toBeUndefined();
  });
});

/**
 * Editorial rule 1: every figure links to the document it came from.
 *
 * A profile spans up to five parliaments and a hundred-odd documents. The page
 * previously rendered ONE source link built from `interests[0]`, which cited the
 * wrong document for every row but the first — a citation pointing at the wrong
 * primary source is worse than none, because it invites a reader to "check" a
 * claim against a PDF that does not contain it.
 */
describe("SourceDocLink", () => {
  it("labels a row with the parliament its document belongs to", () => {
    expect(registerDocLabel("https://www.aph.gov.au/-/media/.../Register/48p/AB/Albanese_48P.pdf")).toBe("48P");
    expect(registerDocLabel("https://www.aph.gov.au/-/media/.../Register/45p/SZ/TurnbullM_45P.pdf")).toBe("45P");
    expect(registerDocLabel("https://www.aph.gov.au/-/media/.../47P/CF/Chandler-Mather_47P.pdf")).toBe("47P");
  });

  it("falls back rather than guessing when the URL carries no parliament", () => {
    // Senate tabled volumes are /-/media/<GUID>.ashx and encode nothing.
    expect(registerDocLabel("https://www.aph.gov.au/-/media/00112233-4455.ashx")).toBe("PDF");
    expect(registerDocLabel(undefined)).toBe("");
    expect(registerDocLabel("")).toBe("");
  });

  it("opens the original in a new tab, safely, and says why", () => {
    const url = "https://www.aph.gov.au/-/media/.../Register/48p/AB/Albanese_48P.pdf";
    const { container } = render(<SourceDocLink sourceUrl={url} />);
    const a = container.querySelector("a")!;
    expect(a.getAttribute("href")).toBe(url);
    expect(a.getAttribute("target")).toBe("_blank");
    // Without noopener the opened tab can reach back into this one.
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a.getAttribute("title")).toMatch(/original register PDF/i);
  });

  it("renders nothing when a row has no source document", () => {
    const { container } = render(<SourceDocLink sourceUrl={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
