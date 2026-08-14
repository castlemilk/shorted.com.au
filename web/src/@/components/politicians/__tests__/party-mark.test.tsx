/**
 * <PartyMark>: a monogram tile, drawn in code, that is deliberately NOT a party
 * logo.
 *
 * Two of the assertions here are licence and posture rules rather than UI ones —
 * the mark must load no asset (a party logo is a registered trademark we have no
 * licence to reproduce) and a row whose party we do not hold must SAY so rather
 * than being coloured in as though we did. Both are the kind of thing that
 * survives review when someone later "improves" the component.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { render } from "@testing-library/react";

import { PartyMark, partyMarkLabel, markInk, markTile } from "../party-mark";
import {
  PARTY_LABEL,
  PARTY_OTHER_COLOR,
  PARTY_COLORS,
  partyColorFromAb,
  partyLabel,
} from "@/lib/politics/party-palette";

const SOURCE = readFileSync(join(__dirname, "..", "party-mark.tsx"), "utf8");
/**
 * The file with its comments removed.
 *
 * The header EXPLAINS at length why there is no logo here, so a naive scan for
 * the word would fail on the very documentation that makes the rule survive.
 * The asset assertions run against the code; the "says why" assertions run
 * against the whole file.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("PartyMark labelling", () => {
  it("names the party in full for every abbreviation the palette knows", () => {
    // The monogram is an abbreviation; a screen reader must hear the party.
    for (const [abbreviation, label] of Object.entries(PARTY_LABEL)) {
      expect(partyMarkLabel(abbreviation)).toBe(label);
    }
    expect(Object.keys(PARTY_LABEL).length).toBeGreaterThan(20);
  });

  it("puts the full name on the rendered mark, not only the monogram", () => {
    const { container } = render(<PartyMark abbreviation="ALP" />);
    const el = container.firstElementChild!;
    expect(el.getAttribute("role")).toBe("img");
    expect(el.getAttribute("aria-label")).toBe("Labor");
    expect(el.getAttribute("title")).toBe("Labor");
    expect(el.textContent).toBe("ALP");
  });

  it("says an abbreviation is unrecognised instead of silently calling it Other", () => {
    // "Other" is a bucket on a chart. On a named member's row it would assert a
    // party we do not hold, so the label names the abbreviation and admits it.
    expect(partyMarkLabel("ZZZ")).toBe("ZZZ (party not in our list)");
  });

  it("keeps the longest historical abbreviation legible", () => {
    const { container } = render(<PartyMark abbreviation="DHJP" />);
    expect(container.firstElementChild!.textContent).toBe("DHJP");
  });
});

describe("the party-not-recorded variant", () => {
  it.each([undefined, null, "", "   "])("renders neutrally for %p", (value) => {
    const { container } = render(<PartyMark abbreviation={value} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute("aria-label")).toBe("Party not recorded");
    expect(el.getAttribute("data-party-recorded")).toBe("false");
    // The neutral grey (deepened for legibility like any other tile), never a
    // party's colour.
    const { background } = markTile(PARTY_OTHER_COLOR);
    const rgb = [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16));
    expect(el.style.backgroundColor).toBe(`rgb(${rgb.join(", ")})`);
    for (const [label, colour] of Object.entries(PARTY_COLORS)) {
      if (label === "Other") continue;
      expect(background).not.toBe(markTile(colour).background);
    }
  });

  it("marks a recorded party as recorded, so a surface can tell them apart", () => {
    const { container } = render(<PartyMark abbreviation="GRN" />);
    expect(container.firstElementChild!.getAttribute("data-party-recorded")).toBe("true");
  });
});

describe("the mark is drawn, never loaded", () => {
  it("references no logo, image or sprite asset of any kind", () => {
    // A party logo is a registered trademark and none of this feature's licences
    // conveys one; the no-endorsement posture rules it out even if one did.
    expect(CODE).not.toMatch(/\.(?:svg|png|jpe?g|webp|avif|gif)\b/i);
    expect(CODE).not.toMatch(/<img\b|next\/image|backgroundImage|url\(/);
    expect(CODE).not.toMatch(/logo/i);
  });

  it("renders no image element and no background image", () => {
    const { container } = render(<PartyMark abbreviation="LP" size="md" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    expect((container.firstElementChild as HTMLElement).style.backgroundImage).toBe("");
  });

  it("says in the file why it is not a logo", () => {
    // The reasoning is the asset here. Without it the next person "fixes" the
    // monogram by dropping in the real marks.
    expect(SOURCE).toMatch(/trademark/i);
    expect(SOURCE).toMatch(/endors/i);
  });

  it("stays client-safe: no compliance kit, no generated protobuf", () => {
    // Importing either takes the static build down with a minified
    // "Element type is invalid" — see client-boundary.test.ts.
    expect(SOURCE).not.toMatch(/from\s+["'][^"']*\/compliance["']/);
    expect(SOURCE).not.toMatch(/from\s+["'](~\/gen\/|@bufbuild\/protobuf|@connectrpc\/connect)/);
  });
});

describe("ink legibility", () => {
  const luminance = (hex: string) => {
    const full = hex.replace("#", "");
    const ch = (i: number) => {
      const v = parseInt(full.slice(i * 2, i * 2 + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2);
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [luminance(a), luminance(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  it("picks the ink that wins on contrast, not one either side of a threshold", () => {
    expect(markInk("#c79a3a")).toBe("#2b2620"); // Nationals, light amber
    expect(markInk("#2f6fb0")).toBe("#fdfbf6"); // Liberal, mid blue
    expect(markInk("#ffffff")).toBe("#2b2620");
    expect(markInk("#000000")).toBe("#fdfbf6");
    // The regression that started this: a lightness threshold put pale ink on
    // One Nation's bright amber at 2.6:1 while the dark ink sat at 5.6:1.
    expect(markInk("#e8842a")).toBe("#2b2620");
  });

  it("clears 4.5:1 for every party in the palette", () => {
    const failing = Object.entries(PARTY_COLORS)
      .map(([label, colour]) => {
        const { background, ink } = markTile(colour);
        return { label, ratio: Number(ratio(background, ink).toFixed(2)) };
      })
      .filter((r) => r.ratio < 4.5);
    // Named, not counted: a failure should say WHICH party's tile went muddy.
    expect(failing).toEqual([]);
  });

  it("deepens only the colours that need it, and only by a shade", () => {
    // The palette picks CHOROPLETH fills, where nothing is written on top, so a
    // few mid-tones cannot carry type. Keeping the hue and darkening a step is
    // what stops a party's mark disagreeing with the same party's chart segment.
    const unchanged = Object.entries(PARTY_COLORS).filter(
      ([, colour]) => markTile(colour).background === colour,
    );
    expect(unchanged.length).toBeGreaterThan(Object.keys(PARTY_COLORS).length / 2);
    for (const [label, colour] of Object.entries(PARTY_COLORS)) {
      const moved = luminance(colour) - luminance(markTile(colour).background);
      expect({ label, tooDark: moved > 0.2 }).toEqual({ label, tooDark: false });
    }
  });

  it("colours from the abbreviation the same way every other surface does", () => {
    const { container } = render(<PartyMark abbreviation="ALP" />);
    expect(partyColorFromAb("ALP")).toBe("#d9544d");
    // Labor's fill is one of the mid-tones that cannot carry type, so the tile
    // is the deepened form of that exact colour — not a different red.
    const { background } = markTile("#d9544d");
    const rgb = [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16));
    expect((container.firstElementChild as HTMLElement).style.backgroundColor).toBe(
      `rgb(${rgb.join(", ")})`,
    );
  });
});

describe("sizes", () => {
  it("offers exactly the two the surfaces need", () => {
    const sm = render(<PartyMark abbreviation="ALP" size="sm" />).container
      .firstElementChild as HTMLElement;
    expect(sm.style.width).toBe("20px");
    const md = render(<PartyMark abbreviation="ALP" size="md" />).container
      .firstElementChild as HTMLElement;
    expect(md.style.width).toBe("28px");
    // sm is the default: most marks sit in a table row.
    const dflt = render(<PartyMark abbreviation="ALP" />).container
      .firstElementChild as HTMLElement;
    expect(dflt.style.width).toBe("20px");
  });
});

/*
 * THE SENATE'S PARTIES.
 *
 * Senator identity brought in abbreviations this palette had never seen — the
 * Senate seats micro-parties the House almost never does — and every one of
 * them rendered as a grey "Other" chip beside a named person. Six of them, on
 * real parliamentarians who sat for real parties.
 *
 * Two of the six were a different failure and are fixed at the WRITE side, not
 * here: PHON is One Nation under a second code, and "UAP [2018]" is UAP with a
 * re-registration qualifier attached. Both are normalised when the term is
 * minted, so they never reach this map — adding them as entries would have
 * given One Nation two chips, two colours and two facet buckets.
 */
describe("the party palette reads the Senate's abbreviations", () => {
  it("labels every party the senate mint writes", () => {
    const expected: Record<string, string> = {
      // Normalised at mint, so these are the codes that actually arrive.
      ON: "One Nation",
      UAP: "United Australia",
      // Genuinely absent labels, added.
      FFP: "Family First",
      GLT: "Glenn Lazarus Team",
      AMEP: "Australian Motoring Enthusiast",
      AV: "Australia's Voice",
      // Already known, asserted so a future edit cannot drop them.
      JLN: "Jacqui Lambie Network",
      LDP: "Liberal Democrats",
      XEN: "Centre Alliance",
      CA: "Centre Alliance",
      PUP: "Palmer United",
      DHJP: "Derryn Hinch's Justice",
    };
    for (const [ab, label] of Object.entries(expected)) {
      expect(partyLabel(ab)).toBe(label);
    }
  });

  it("gives each of them a colour that is not the Other grey", () => {
    for (const ab of ["ON", "UAP", "FFP", "GLT", "AMEP", "AV"]) {
      expect(partyColorFromAb(ab)).not.toBe(PARTY_OTHER_COLOR);
    }
  });

  it("puts One Nation's two source codes on ONE chip", () => {
    // PHON never reaches the palette — it is normalised to ON at mint — but if
    // it ever did, it must not become a second One Nation.
    expect(partyLabel("ON")).toBe("One Nation");
    expect(partyLabel("PHON")).toBe("Other");
  });

  it("still says Other for something genuinely unknown", () => {
    // A caveat that covers everything covers nothing: an unrecognised party
    // must still be visibly unrecognised rather than mislabelled.
    expect(partyLabel("ZZZ")).toBe("Other");
    expect(partyColorFromAb("ZZZ")).toBe(PARTY_OTHER_COLOR);
  });
});
