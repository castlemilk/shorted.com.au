import { OG, OG_SIZE, OG_CONTENT_TYPE, OgCard, OgVersus } from "../card";

/**
 * The generators themselves need a real satori render to prove they work, so
 * these tests cover what a unit test usefully can: the card's contract, and
 * the two satori rules that actually break production cards.
 */

type El = {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown; style?: Record<string, unknown> };
};

/**
 * Walks the element tree, INVOKING function components as it goes.
 *
 * Without that step the walker stops at `<VersusSide />` and never sees the
 * markup it returns — so the satori rules would go unchecked exactly inside
 * the nested components most likely to break them.
 */
function walk(node: unknown, visit: (el: El) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, visit));
    return;
  }
  const el = node as El;
  if (!el.props) return;

  if (typeof el.type === "function") {
    const render = el.type as (props: unknown) => unknown;
    walk(render(el.props), visit);
    return;
  }

  visit(el);
  walk(el.props.children, visit);
}

const CARD = OgCard({
  eyebrow: "ASX short selling",
  title: "Where short sellers are building",
  subtitle: "Official ASIC data, updated daily.",
  stats: [
    { label: "Total shorted", value: "$88.3B" },
    { label: "Rising", value: "+1.08pp", tone: "up" },
    { label: "Covering", value: "-0.44pp", tone: "down" },
  ],
  logoSrc: "data:image/png;base64,AAAA",
});

describe("OgCard", () => {
  it("exports the 1200x630 OG contract", () => {
    expect(OG_SIZE).toEqual({ width: 1200, height: 630 });
    expect(OG_CONTENT_TYPE).toBe("image/png");
  });

  it("never emits radial-gradient — satori cannot parse it", () => {
    const offenders: string[] = [];
    walk(CARD, (el) => {
      const bgi = el.props.style?.backgroundImage;
      if (typeof bgi === "string" && bgi.includes("radial-gradient")) {
        offenders.push(bgi);
      }
    });
    expect(offenders).toEqual([]);
  });

  it("gives every multi-child node an explicit display, which satori requires", () => {
    const missing: string[] = [];
    walk(CARD, (el) => {
      const kids = el.props.children;
      const count = Array.isArray(kids)
        ? kids.filter((k) => k !== null && k !== undefined && k !== false).length
        : kids === undefined
          ? 0
          : 1;
      if (count > 1 && el.props.style?.display === undefined) {
        missing.push(JSON.stringify(el.props.style ?? {}).slice(0, 80));
      }
    });
    expect(missing).toEqual([]);
  });

  it("renders the supplied copy and stats", () => {
    const text: string[] = [];
    walk(CARD, (el) => {
      const k = el.props.children;
      if (typeof k === "string") text.push(k);
    });
    expect(text).toEqual(
      expect.arrayContaining([
        "ASX short selling",
        "Where short sellers are building",
        "Official ASIC data, updated daily.",
        "$88.3B",
        "shorted.com.au",
      ]),
    );
  });

  it("colours a rising short red and a covering short green", () => {
    const colours: string[] = [];
    walk(CARD, (el) => {
      const k = el.props.children;
      if (k === "+1.08pp" || k === "-0.44pp") {
        colours.push(String(el.props.style?.color));
      }
    });
    expect(colours).toEqual([OG.red, OG.green]);
  });

  it("degrades to a card with no mark when the logo is unavailable", () => {
    const noLogo = OgCard({ eyebrow: "x", title: "y", logoSrc: "" });
    let imgs = 0;
    walk(noLogo, (el) => {
      if (el.type === "img") imgs += 1;
    });
    // A crawler must get a card, not a 500, when the logo can't be read.
    expect(imgs).toBe(0);
  });
});

describe("OgVersus", () => {
  const VS = OgVersus({
    eyebrow: "ASX short interest",
    left: { code: "BHP", name: "BHP Group", value: "1.47%", caption: "shorted" },
    right: {
      code: "CBA",
      name: "Commonwealth Bank of Australia",
      value: "2.06%",
      caption: "shorted",
    },
    logoSrc: "data:image/png;base64,AAAA",
  });

  it("obeys the same satori rules as the standard card", () => {
    const radial: string[] = [];
    const missingDisplay: string[] = [];
    walk(VS, (el) => {
      const bgi = el.props.style?.backgroundImage;
      if (typeof bgi === "string" && bgi.includes("radial-gradient")) {
        radial.push(bgi);
      }
      const kids = el.props.children;
      const count = Array.isArray(kids)
        ? kids.filter((k) => k !== null && k !== undefined && k !== false).length
        : kids === undefined
          ? 0
          : 1;
      if (count > 1 && el.props.style?.display === undefined) {
        missingDisplay.push(JSON.stringify(el.props.style ?? {}).slice(0, 80));
      }
    });
    expect(radial).toEqual([]);
    expect(missingDisplay).toEqual([]);
  });

  it("renders both sides and the divider", () => {
    const text: string[] = [];
    walk(VS, (el) => {
      const k = el.props.children;
      if (typeof k === "string") text.push(k);
    });
    expect(text).toEqual(
      expect.arrayContaining(["BHP", "CBA", "1.47%", "2.06%", "vs"]),
    );
  });
});
