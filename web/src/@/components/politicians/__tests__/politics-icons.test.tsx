/**
 * The politics icon sprite: the manifest, the slicing maths, and the a11y
 * contract.
 *
 * The manifest is GENERATED, so the interesting failures are not typos — they
 * are a register item quietly losing its icon after someone reorders `ICONS`,
 * and a decorative glyph acquiring an accessible name and being read aloud
 * beside a member's name. Both are checked here.
 */

import { render } from "@testing-library/react";

import { PoliticsIcon } from "../politics-icon";
import { POLITICS_ICONS } from "../politics-icons.generated";
import { REGISTER_ITEM_ICON, registerItemIcon, RECEIPT_TYPE_ICON, HOLDER_ICON } from "@/lib/politics/register-item-icons";
import { REGISTER_ITEMS } from "@/lib/politics/register-items";
import { RECEIPT_TYPE_ORDER } from "@/lib/politics/funding-money";

const names = Object.keys(POLITICS_ICONS.icons);

describe("politics icon manifest", () => {
  it("packs every icon into a deterministic grid", () => {
    // A guard on the packer: coords are derived from config ORDER, so a
    // duplicated or missing cell means two icons render as one another.
    const seen = new Set<string>();
    names.forEach((name, i) => {
      const pos = POLITICS_ICONS.icons[name as keyof typeof POLITICS_ICONS.icons];
      expect(pos).toEqual({
        x: (i % 6) * POLITICS_ICONS.cell,
        y: Math.floor(i / 6) * POLITICS_ICONS.cell,
      });
      const key = `${pos.x},${pos.y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    });
    // And the sheet is exactly big enough to hold them.
    expect(POLITICS_ICONS.width).toBe(6 * POLITICS_ICONS.cell);
    expect(POLITICS_ICONS.height).toBe(Math.ceil(names.length / 6) * POLITICS_ICONS.cell);
  });

  it("busts its own cache when the artwork changes", () => {
    // The sprite is a public asset with a long cache life; without the content
    // hash a regenerated icon would never reach a returning reader.
    expect(POLITICS_ICONS.sheet).toMatch(/^\/politics-icons\/politics-icons\.png\?v=[0-9a-f]{8}$/);
  });

  it("has no duplicate ids", () => {
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("the five groups", () => {
  it("account for every icon, exactly once", () => {
    const grouped = Object.values(POLITICS_ICONS.groups).flat();
    expect(grouped.sort()).toEqual([...names].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("covers the register, the holders, the funding types, activity and ui", () => {
    expect(Object.keys(POLITICS_ICONS.groups).sort()).toEqual([
      "activity",
      "funding",
      "holder",
      "register",
      "ui",
    ]);
    // The register group is the form's fourteen items and nothing else — a
    // fifteenth would mean we invented a category.
    expect(POLITICS_ICONS.groups.register).toHaveLength(14);
    expect(POLITICS_ICONS.groups.holder).toHaveLength(3);
    expect(POLITICS_ICONS.groups.funding).toHaveLength(5);
  });
});

describe("register item -> icon", () => {
  it("maps all fourteen items, to icons that exist", () => {
    const items = Object.keys(REGISTER_ITEMS).map(Number).sort((a, b) => a - b);
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    for (const no of items) {
      const icon = registerItemIcon(no);
      expect(icon).toBeDefined();
      expect(names).toContain(icon);
      // And it is a REGISTER icon, not a ui accent borrowed to fill a hole.
      expect(POLITICS_ICONS.groups.register).toContain(icon);
    }
  });

  it("gives every item a distinct icon, so two categories never look alike", () => {
    const icons = Object.values(REGISTER_ITEM_ICON);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("renders nothing for an item it cannot name", () => {
    expect(registerItemIcon(undefined)).toBeUndefined();
    expect(registerItemIcon(0)).toBeUndefined();
    expect(registerItemIcon(99)).toBeUndefined();
  });

  it("maps every AEC receipt type and every holder kind", () => {
    for (const key of RECEIPT_TYPE_ORDER) {
      expect(POLITICS_ICONS.groups.funding).toContain(RECEIPT_TYPE_ICON[key]);
    }
    expect(Object.keys(RECEIPT_TYPE_ICON).sort()).toEqual([...RECEIPT_TYPE_ORDER].sort());
    for (const icon of Object.values(HOLDER_ICON)) {
      expect(POLITICS_ICONS.groups.holder).toContain(icon);
    }
  });
});

describe("<PoliticsIcon>", () => {
  it("is decorative by default, so the label beside it carries the meaning", () => {
    const { container } = render(<PoliticsIcon name="gifts" />);
    const el = container.firstElementChild!;
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect(el.getAttribute("role")).toBeNull();
    expect(el.getAttribute("aria-label")).toBeNull();
  });

  it("takes an accessible name only when asked, for a standalone icon", () => {
    const { container } = render(<PoliticsIcon name="gifts" title="Gifts" />);
    const el = container.firstElementChild!;
    expect(el.getAttribute("role")).toBe("img");
    expect(el.getAttribute("aria-label")).toBe("Gifts");
    expect(el.getAttribute("aria-hidden")).toBeNull();
  });

  it("slices the right cell at the requested size", () => {
    const { container } = render(<PoliticsIcon name="public-funding" size={32} />);
    const style = (container.firstElementChild as HTMLElement).style;
    const pos = POLITICS_ICONS.icons["public-funding"];
    const scale = 32 / POLITICS_ICONS.cell;
    expect(style.width).toBe("32px");
    expect(style.backgroundPosition).toBe(`-${pos.x * scale}px -${pos.y * scale}px`);
    expect(style.backgroundSize).toBe(
      `${POLITICS_ICONS.width * scale}px ${POLITICS_ICONS.height * scale}px`,
    );
    expect(style.backgroundImage).toContain(POLITICS_ICONS.sheet);
  });

  it("renders nothing for a name the sprite does not hold", () => {
    // Defensive: the type union prevents this in source, but a value crossing
    // the RSC boundary from a store is a string at runtime.
    const { container } = render(
      <PoliticsIcon name={"not-an-icon" as keyof typeof POLITICS_ICONS.icons} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
