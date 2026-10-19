import React from "react";
import { OG } from "../card";
import { OgChartCard, type OgChartCardProps } from "../chart-card";
import type { SeriesPoint } from "../chart-image";

type El = {
  type: unknown;
  props: Record<string, unknown> & {
    children?: unknown;
    style?: Record<string, unknown>;
  };
};

/**
 * Walks the element tree as satori would see it: function components are
 * invoked, fragments are transparent, and an <svg> is a leaf (satori hands it
 * to resvg whole, so the HTML layout rules do not apply inside it).
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
    walk((el.type as (p: unknown) => unknown)(el.props), visit);
    return;
  }
  if (el.type === React.Fragment) {
    walk(el.props.children, visit);
    return;
  }
  visit(el);
  if (el.type !== "svg") walk(el.props.children, visit);
}

function texts(node: unknown): string[] {
  const out: string[] = [];
  walk(node, (el) => {
    if (typeof el.props.children === "string") out.push(el.props.children);
  });
  return out;
}

const DAY = 86_400_000;
const T0 = Date.parse("2026-09-15T00:00:00Z");
const pts = (n: number, f: (i: number) => number): SeriesPoint[] =>
  Array.from({ length: n }, (_, i) => ({ t: T0 + i * DAY, v: f(i) }));

const BASE: OgChartCardProps = {
  code: "WBT",
  company: "Weebit Nano Ltd",
  view: "combined",
  subject: "Share price and short interest",
  periodPhrase: "past month",
  source: "ASIC short position reports and end-of-day ASX prices",
  short: pts(28, (i) => 2 + i / 20),
  price: pts(28, (i) => 3.5 - i / 30),
  logoSrc: "data:image/png;base64,AAAA",
};

describe("OgChartCard", () => {
  it("gives every multi-child node an explicit display, which satori requires", () => {
    for (const props of [
      BASE,
      { ...BASE, short: [], price: [] },
      { ...BASE, view: "short" as const },
    ]) {
      const missing: string[] = [];
      walk(OgChartCard(props), (el) => {
        const kids = el.props.children;
        const count = Array.isArray(kids)
          ? kids
              .flat()
              .filter((k) => k !== null && k !== undefined && k !== false)
              .length
          : kids === undefined
            ? 0
            : 1;
        if (
          el.type !== "svg" &&
          count > 1 &&
          el.props.style?.display === undefined
        ) {
          missing.push(
            `${String(el.type)} ${JSON.stringify(el.props.style ?? {}).slice(0, 80)}`,
          );
        }
      });
      expect(missing).toEqual([]);
    }
  });

  it("never emits radial-gradient — satori cannot parse it", () => {
    walk(OgChartCard(BASE), (el) => {
      const bgi = el.props.style?.backgroundImage;
      if (typeof bgi === "string") expect(bgi).not.toContain("radial-gradient");
    });
  });

  it("names the stock, the chart, the latest readings and the source", () => {
    const t = texts(OgChartCard(BASE));
    expect(t).toEqual(
      expect.arrayContaining([
        "WBT",
        "Weebit Nano Ltd",
        "Share price and short interest · past month",
        "$2.60",
        "3.35%",
        "+1.35 pp",
        "shorted.com.au",
        "As of 12 Oct 2026 · ASIC short position reports and end-of-day ASX prices",
      ]),
    );
  });

  it("never colours the short interest change red or green", () => {
    for (const short of [pts(5, (i) => 2 + i), pts(5, (i) => 6 - i)]) {
      walk(OgChartCard({ ...BASE, short }), (el) => {
        const k = el.props.children;
        if (typeof k === "string" && k.endsWith(" pp")) {
          expect(el.props.style?.color).toBe(OG.text);
        }
      });
    }
  });

  it("colours the price change by its direction", () => {
    const colourOf = (price: SeriesPoint[]) => {
      let colour: unknown;
      walk(OgChartCard({ ...BASE, price }), (el) => {
        const k = el.props.children;
        if (typeof k === "string" && /^[+−]\d.*%$/.test(k))
          colour = el.props.style?.color;
      });
      return colour;
    };
    expect(colourOf(pts(5, (i) => 2 + i))).toBe(OG.green);
    expect(colourOf(pts(5, (i) => 6 - i))).toBe(OG.red);
  });

  it("shows only the series its view is about", () => {
    const short = texts(OgChartCard({ ...BASE, view: "short" }));
    expect(short).toContain("Short interest");
    expect(short).not.toContain("Share price");
    const price = texts(OgChartCard({ ...BASE, view: "price" }));
    expect(price).toContain("Share price");
    expect(price).not.toContain("Short interest");
  });

  it("says the data is unavailable instead of drawing empty axes", () => {
    const card = OgChartCard({ ...BASE, short: [], price: [] });
    let svgs = 0;
    walk(card, (el) => {
      if (el.type === "svg") svgs += 1;
    });
    expect(svgs).toBe(0);
    expect(texts(card)).toEqual(
      expect.arrayContaining([
        "WBT",
        "Chart data unavailable",
        "See the live chart at shorted.com.au/shorts/WBT",
        "ASIC short position reports and end-of-day ASX prices",
      ]),
    );
  });

  it("draws the plot as inline SVG paths", () => {
    const paths: string[] = [];
    walk(OgChartCard(BASE), (el) => {
      if (el.type !== "svg") return;
      const kids = [el.props.children].flat(3) as El[];
      for (const k of kids) {
        if (k && typeof k === "object" && k.type === "path")
          paths.push(String(k.props.d));
      }
    });
    // price area + price line + short line
    expect(paths).toHaveLength(3);
    expect(paths.every((d) => d.startsWith("M"))).toBe(true);
  });
});
