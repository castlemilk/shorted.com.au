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

import { RegisterItemTag } from "../compliance";
import { REGISTER_ITEMS, registerItem } from "@/lib/politics/register-items";

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

  it("renders the icon decoratively, with the label carrying the meaning", () => {
    const { container } = render(<RegisterItemTag itemNo={11} />);
    expect(screen.getByText("Gift")).toBeInTheDocument();
    // The emoji must be aria-hidden so a screen reader hears "Gift", not
    // "wrapped present Gift".
    expect(container.querySelector('[aria-hidden="true"]')?.textContent).toBe("🎁");
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
