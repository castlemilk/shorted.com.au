import { fireEvent, render, within } from "@testing-library/react";
import {
  ChartReadoutStrip,
  VOLUME_EXPLAINER,
  pinnedAnnouncement,
} from "../chart-readout-strip";
import {
  readoutStripHeight,
  type ReadoutDelta,
  type ReadoutEntry,
  type ReadoutModel,
} from "../chart-readout";

const GREEN = "rgb(22, 163, 74)";
const RED = "rgb(220, 38, 38)";
/** U+2212, DESIGN.md's minus. Written as an escape: it looks like a hyphen. */
const MINUS = "\u2212";
/** U+2013, the glyph of no change, as the stock header prints it. */
const FLAT = "\u2013";

const delta = (over: Partial<ReadoutDelta> = {}): ReadoutDelta => ({
  value: 3.1,
  text: "+3.1%",
  tone: "up",
  colored: true,
  ...over,
});
const entry = (over: Partial<ReadoutEntry> = {}): ReadoutEntry => ({
  id: "price",
  label: "Price",
  color: "#3b82f6",
  value: "$43.21",
  change: null,
  dateNote: null,
  ohlc: null,
  ...over,
});
const model = (over: Partial<ReadoutModel> = {}): ReadoutModel => ({
  state: "latest",
  headline: "Latest · 9 Oct 2026",
  entries: [entry()],
  ...over,
});

function renderStrip(
  m: ReadoutModel,
  props: {
    width?: number;
    height?: number;
    pinned?: boolean;
    valueChars?: Record<string, number>;
    onRelease?: () => void;
    seriesRows?: number;
  } = {},
) {
  const width = props.width ?? 400;
  return render(
    <ChartReadoutStrip
      model={m}
      width={width}
      // StockChart hands over the height it took off the svg; absent one, the
      // width and the number of series say which, as they do there.
      height={
        props.height ??
        readoutStripHeight(width, Math.max(m.entries.length, props.seriesRows ?? 0))
      }
      pinned={props.pinned ?? false}
      valueChars={props.valueChars}
      onRelease={props.onRelease ?? jest.fn()}
      seriesRows={props.seriesRows}
    />,
  );
}

describe("ChartReadoutStrip", () => {
  it("renders the model's state, headline, and each entry's label and value", () => {
    const { container } = renderStrip(
      model({ entries: [entry(), entry({ id: "short", label: "Short %", value: "3.20%" })] }),
    );
    const strip = container.querySelector<HTMLElement>("[data-chart-readout]")!;
    expect(strip.getAttribute("data-readout-state")).toBe("latest");
    expect(strip.getAttribute("aria-live")).toBe("off");
    expect(strip.hasAttribute("data-pinned")).toBe(false);
    expect(strip.hasAttribute("data-chart")).toBe(false);
    expect(strip.querySelector("[data-readout-headline]")!.textContent).toBe(
      "Latest · 9 Oct 2026",
    );
    expect(within(strip).getByText("Price")).toBeTruthy();
    expect(within(strip).getByText("$43.21")).toBeTruthy();
    expect(within(strip).getByText("Short %")).toBeTruthy();
    expect(within(strip).getByText("3.20%")).toBeTruthy();
  });

  it("holds no svg, so the chart's own is the first in its container", () => {
    const { container } = renderStrip(model(), { pinned: true });
    expect(container.querySelector("svg")).toBeNull();
  });

  it("is as tall as it is told: the svg beneath it gave up exactly that", () => {
    const heightOf = (width: number, height: number) => {
      const r = renderStrip(model(), { width, height });
      const h = r.container.querySelector<HTMLElement>("[data-chart-readout]")!.style.height;
      r.unmount();
      return h;
    };
    expect(heightOf(639, 44)).toBe("44px");
    expect(heightOf(640, 28)).toBe("28px");
    // Not a number it works out for itself from the width.
    expect(heightOf(800, 36)).toBe("36px");
    expect(heightOf(360, 50)).toBe("50px");
  });

  it("gives the one row of the wide strip all of the height it is told", () => {
    const { container } = renderStrip(model(), { width: 800, height: 36 });
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-readout-row]"));
    expect(rows.map((r) => r.style.height)).toEqual(["36px"]);
  });

  describe("a phone strip: a headline row, then a row for each series", () => {
    const two = model({
      entries: [entry(), entry({ id: "short", label: "Short %", value: "3.20%" })],
    });
    const rowHeights = (c: HTMLElement) =>
      Array.from(c.querySelectorAll<HTMLElement>("[data-readout-row]")).map((r) => r.style.height);

    it("is 26px of headline and 18px a series: 44px for one series, 62px for two", () => {
      const one = renderStrip(model(), { width: 360 });
      expect(rowHeights(one.container)).toEqual(["26px", "18px"]);
      expect(one.container.querySelector<HTMLElement>("[data-chart-readout]")!.style.height).toBe("44px");
      one.unmount();

      const both = renderStrip(two, { width: 360, pinned: true });
      expect(rowHeights(both.container)).toEqual(["26px", "18px", "18px"]);
      expect(both.container.querySelector<HTMLElement>("[data-chart-readout]")!.style.height).toBe("62px");
    });

    it("gives the headline row whatever the series rows leave of the height it was told", () => {
      // 18px a series, whatever the height: the headline row takes the rest.
      const taller = renderStrip(two, { width: 360, height: 70 });
      expect(rowHeights(taller.container)).toEqual(["34px", "18px", "18px"]);
      taller.unmount();
      // Never a negative height, if it is told less than the series need.
      const squeezed = renderStrip(two, { width: 360, height: 20 });
      expect(rowHeights(squeezed.container)).toEqual(["0px", "18px", "18px"]);
    });

    it("keeps a headline row, and no more, for a chart with no series", () => {
      const none = renderStrip(model({ entries: [] }), { width: 360 });
      expect(rowHeights(none.container)).toEqual(["26px"]);
      expect(none.container.querySelector<HTMLElement>("[data-chart-readout]")!.style.height).toBe("26px");
    });

    it("puts the headline and the Pinned chip on the first row, and each series on a row of its own", () => {
      const { container } = renderStrip(two, { width: 360, pinned: true });
      const [head, first, second, ...rest] = Array.from(
        container.querySelectorAll<HTMLElement>("[data-readout-row]"),
      );
      expect(rest).toHaveLength(0);
      expect(head!.querySelector("[data-readout-headline]")).not.toBeNull();
      expect(head!.querySelector("[data-readout-chip]")).not.toBeNull();
      expect(head!.querySelector("[data-readout-entry]")).toBeNull();
      // One entry on each, in series order: no entry shares a row.
      expect(first!.querySelectorAll("[data-readout-entry]")).toHaveLength(1);
      expect(second!.querySelectorAll("[data-readout-entry]")).toHaveLength(1);
      expect(first!.querySelector('[data-readout-entry="price"]')).not.toBeNull();
      expect(second!.querySelector('[data-readout-entry="short"]')).not.toBeNull();
      // They are still found together, under one wrapper, as on one row.
      expect(container.querySelectorAll("[data-readout-entries]")).toHaveLength(1);
    });

    it("shows an entry whole on its row: dot, label, value, change and date note", () => {
      const { container } = renderStrip(
        model({ entries: [entry({ change: delta(), dateNote: "5 Oct" })] }),
        { width: 360 },
      );
      const entryEl = container.querySelector<HTMLElement>("[data-readout-entry]")!;
      expect(Array.from(entryEl.children, (el) => el.textContent)).toEqual([
        "",
        "Price",
        "$43.21",
        "+3.1%",
        "· 5 Oct",
      ]);
    });
  });

  describe("a phone strip that holds rows for series that have not arrived", () => {
    const one = model({ entries: [entry()] });
    const both = model({
      entries: [entry(), entry({ id: "short", label: "Short %", value: "3.20%" })],
    });
    const rowHeights = (c: HTMLElement) =>
      Array.from(c.querySelectorAll<HTMLElement>("[data-readout-row]")).map((r) => r.style.height);
    const stripOf = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-chart-readout]")!;
    const reserved = (c: HTMLElement) =>
      Array.from(c.querySelectorAll<HTMLElement>("[data-readout-reserved]"));

    it("lays the row of a series still to come out empty, under the entries it has", () => {
      const { container } = renderStrip(one, { width: 360, seriesRows: 2 });
      // 8 + 18 x (1 + 2): the height of the strip with both series in.
      expect(stripOf(container).style.height).toBe("62px");
      // The headline row is what the series rows leave, as with both in...
      expect(rowHeights(container)).toEqual(["26px", "18px"]);
      expect(container.querySelectorAll("[data-readout-entry]")).toHaveLength(1);
      // ...and the second series' row is there, 18px, with nothing in it.
      expect(reserved(container)).toHaveLength(1);
      expect(reserved(container)[0]!.style.height).toBe("18px");
      expect(reserved(container)[0]!.textContent).toBe("");
      expect(reserved(container)[0]!.getAttribute("aria-hidden")).toBe("true");
    });

    it("is the same strip, to the pixel, when the series arrives", () => {
      const waiting = renderStrip(one, { width: 360, seriesRows: 2 });
      const before = { strip: stripOf(waiting.container).style.height, rows: rowHeights(waiting.container) };
      waiting.unmount();
      const arrived = renderStrip(both, { width: 360, seriesRows: 2 });
      expect(stripOf(arrived.container).style.height).toBe(before.strip);
      // The headline row and the first series' row stay put; the second takes
      // the row that was held for it.
      expect(rowHeights(arrived.container)).toEqual([...before.rows, "18px"]);
      expect(reserved(arrived.container)).toHaveLength(0);
    });

    it("holds a row for each series to come: three rows over one entry", () => {
      const { container } = renderStrip(one, { width: 360, seriesRows: 3 });
      expect(stripOf(container).style.height).toBe("80px");
      expect(rowHeights(container)).toEqual(["26px", "18px"]);
      expect(reserved(container)).toHaveLength(2);
    });

    it("never holds fewer rows than there are entries", () => {
      const { container } = renderStrip(both, { width: 360, seriesRows: 1, height: 62 });
      expect(rowHeights(container)).toEqual(["26px", "18px", "18px"]);
      expect(reserved(container)).toHaveLength(0);
    });

    it("holds nothing on one row, where every series shares the 28px", () => {
      const { container } = renderStrip(one, { width: 800, seriesRows: 2 });
      expect(stripOf(container).style.height).toBe("28px");
      expect(reserved(container)).toHaveLength(0);
    });

    it("holds nothing when it is not asked to", () => {
      const { container } = renderStrip(one, { width: 360 });
      expect(stripOf(container).style.height).toBe("44px");
      expect(reserved(container)).toHaveLength(0);
    });
  });

  it("leaves the headline out when there is none, and keeps the entries", () => {
    const { container } = renderStrip(model({ headline: "" }));
    expect(container.querySelector("[data-readout-headline]")).toBeNull();
    expect(container.querySelector("[data-readout-entry]")).not.toBeNull();
  });

  describe("a change", () => {
    const changeOf = (c: HTMLElement, text: string) => within(c).getByText(text);

    it("is green up and red down when it is market direction", () => {
      const { container } = renderStrip(
        model({
          entries: [
            entry({ change: delta() }),
            entry({
              id: "b",
              label: "B",
              change: delta({ value: -2.5, text: `${MINUS}2.5%`, tone: "down" }),
            }),
          ],
        }),
      );
      expect(changeOf(container, "+3.1%").style.color).toBe(GREEN);
      expect(changeOf(container, `${MINUS}2.5%`).style.color).toBe(RED);
    });

    it("takes no colour when flat", () => {
      const { container } = renderStrip(
        model({
          entries: [entry({ change: delta({ value: 0, text: "0.0%", tone: "flat" }) })],
        }),
      );
      expect(changeOf(container, "0.0%").style.color).toBe("");
    });

    it("keeps a percentage-point change in the foreground, with a glyph that is hidden from assistive technology", () => {
      const up = delta({ value: 0.21, text: "+0.21 pp", colored: false });
      const down = delta({ value: -1.1, text: `${MINUS}1.10 pp`, tone: "down", colored: false });
      const flat = delta({ value: 0, text: "0.00 pp", tone: "flat", colored: false });
      const { container } = renderStrip(
        model({
          entries: [
            entry({ id: "u", label: "U", change: up }),
            entry({ id: "d", label: "D", change: down }),
            entry({ id: "f", label: "F", change: flat }),
          ],
        }),
      );
      for (const [text, glyph] of [
        ["+0.21 pp", "▲"],
        [`${MINUS}1.10 pp`, "▼"],
        ["0.00 pp", FLAT],
      ] as const) {
        const el = changeOf(container, text);
        expect(el.style.color).toBe("");
        expect(el.previousElementSibling!.textContent).toBe(glyph);
        expect(el.previousElementSibling!.getAttribute("aria-hidden")).toBe("true");
      }
    });

    it("prints a percentage-point change as the stock header does: glyph, a space, the signed value, pp", () => {
      // The header's 30-day change reads "▲ +0.50 pp", "▼ −0.31 pp" and
      // "– 0.00 pp" (stock-header.test.tsx pins the same three strings), so one
      // figure reads one way wherever it is on the page.
      const textOf = (change: ReadoutDelta) => {
        const r = renderStrip(model({ entries: [entry({ change })] }), { width: 800 });
        const text = r.container.querySelector("[data-readout-change]")!.textContent;
        r.unmount();
        return text;
      };
      expect(textOf(delta({ value: 0.62, text: "+0.62 pp", colored: false }))).toBe("▲ +0.62 pp");
      expect(
        textOf(delta({ value: -0.31, text: `${MINUS}0.31 pp`, tone: "down", colored: false })),
      ).toBe(`▼ ${MINUS}0.31 pp`);
      expect(
        textOf(delta({ value: 0, text: "0.00 pp", tone: "flat", colored: false })),
      ).toBe(`${FLAT} 0.00 pp`);
    });

    it("prints a price change as coloured relative text with no glyph", () => {
      const textOf = (change: ReadoutDelta) => {
        const r = renderStrip(model({ entries: [entry({ change })] }), { width: 800 });
        const el = r.container.querySelector("[data-readout-change]")!;
        const out = { text: el.textContent, glyphs: el.querySelectorAll("[aria-hidden]").length };
        r.unmount();
        return out;
      };
      expect(textOf(delta())).toEqual({ text: "+3.1%", glyphs: 0 });
      expect(textOf(delta({ value: -2.5, text: `${MINUS}2.5%`, tone: "down" }))).toEqual({
        text: `${MINUS}2.5%`,
        glyphs: 0,
      });
      expect(textOf(delta({ value: 0, text: "0.0%", tone: "flat" }))).toEqual({
        text: "0.0%",
        glyphs: 0,
      });
    });

    it("is absent, with room kept for it, when the entry names no change", () => {
      // On one row: the entries after this one must not move when a change comes
      // and goes, so the slot is held, empty and hidden from assistive technology.
      const { container } = renderStrip(model({ state: "hover" }), { width: 800 });
      expect(container.querySelector("[data-readout-change]")).toBeNull();
      const slots = container.querySelectorAll('[data-readout-entry] > [style*="min-width: 10ch"]');
      expect(slots).toHaveLength(1);
      expect(slots[0]!.getAttribute("aria-hidden")).toBe("true");
      expect(slots[0]!.textContent).toBe("");
    });

    it("is absent, and takes no room, when the entry names no change on a phone", () => {
      const { container } = renderStrip(model({ state: "hover" }), { width: 400 });
      expect(container.querySelector("[data-readout-change]")).toBeNull();
      expect(container.querySelector('[data-readout-entry] > [style*="min-width"]')).toBeNull();
    });
  });

  describe("a value and its date", () => {
    it("reads n/a for a series with no value, never a dash", () => {
      const { container } = renderStrip(model({ entries: [entry({ value: null })] }));
      expect(within(container).getByText("n/a")).toBeTruthy();
      expect(container.querySelector("[data-readout-value]")!.textContent).toBe("n/a");
      expect(container.textContent).not.toContain("\u2014"); // the em dash it used to be
      expect(container.querySelector("[data-readout-entry]")!.textContent).toContain("Price");
    });

    it("reads n/a for a missing value on one row as on a phone", () => {
      for (const width of [360, 800]) {
        const r = renderStrip(model({ entries: [entry({ value: null })] }), { width });
        expect(r.container.querySelector("[data-readout-value]")!.textContent).toBe("n/a");
        r.unmount();
      }
    });

    it("dates a value that is on another day than the headline", () => {
      const { container } = renderStrip(model({ entries: [entry({ dateNote: "5 Oct" })] }));
      expect(container.querySelector("[data-readout-date-note]")!.textContent).toBe("· 5 Oct");
    });

    it("shows no date note when the value is on the headline's day", () => {
      const { container } = renderStrip(model());
      expect(container.querySelector("[data-readout-date-note]")).toBeNull();
    });
  });

  describe("a measure", () => {
    const measure = model({
      state: "measure",
      headline: "1 Sep 2026 → 9 Oct 2026",
      entries: [
        entry({ change: delta() }),
        entry({ id: "short", label: "Short %", change: null }),
      ],
    });

    it("carries data-chart=measure-readout, and names changes, not values", () => {
      const { container } = renderStrip(measure);
      const strip = container.querySelector("[data-chart-readout]")!;
      expect(strip.getAttribute("data-chart")).toBe("measure-readout");
      expect(strip.getAttribute("data-readout-state")).toBe("measure");
      expect(container.querySelector("[data-readout-value]")).toBeNull();
      expect(within(container as HTMLElement).queryByText("$43.21")).toBeNull();
      expect(within(container as HTMLElement).getByText("+3.1%")).toBeTruthy();
    });

    it("reads n/a for a series with no change to name, never a dash", () => {
      const { container } = renderStrip(measure);
      const short = container.querySelector<HTMLElement>('[data-readout-entry="short"]')!;
      expect(within(short).getByText("n/a")).toBeTruthy();
      expect(short.textContent).not.toContain("\u2014");
    });
  });

  describe("the room each entry keeps", () => {
    const widthOf = (el: Element) => (el as HTMLElement).style.minWidth;
    const slots = (c: HTMLElement) =>
      Array.from(c.querySelectorAll<HTMLElement>('[data-readout-entry] > [style*="min-width: 10ch"]'));

    it("on one row, holds the room of a change in every state, so a hover does not shift the entries after it", () => {
      const withChange = renderStrip(model({ entries: [entry({ change: delta() })] }), { width: 800 });
      const hover = renderStrip(model({ state: "hover" }), { width: 800 });
      expect(slots(withChange.container)).toHaveLength(1);
      expect(slots(hover.container)).toHaveLength(1);
      // The empty slot is as wide as the one a change sits in, and hides nothing.
      expect(hover.container.querySelector("[data-readout-change]")).toBeNull();
      expect(slots(hover.container)[0]!.getAttribute("aria-hidden")).toBe("true");
      expect(widthOf(slots(withChange.container)[0]!)).toBe(widthOf(slots(hover.container)[0]!));
    });

    it("on one row, gives a value room for six characters; on a phone, which gives each series a row, none", () => {
      const wide = renderStrip(model(), { width: 800 });
      expect(widthOf(wide.container.querySelector("[data-readout-value]")!)).toBe("6ch");
      wide.unmount();
      const narrow = renderStrip(model(), { width: 400 });
      expect(widthOf(narrow.container.querySelector("[data-readout-value]")!)).toBe("");
    });

    describe("for a value wider than the usual six characters", () => {
      const valueRoom = (width: number, valueChars?: Record<string, number>) => {
        const r = renderStrip(model(), { width, valueChars });
        const room = widthOf(r.container.querySelector("[data-readout-value]")!);
        r.unmount();
        return room;
      };

      it("on one row, holds the room of the widest value the series can show", () => {
        // "$165.40" is seven characters: a scrub from $99.99 to $100.00 moves nothing.
        expect(valueRoom(800, { price: 7 })).toBe("7ch");
        expect(valueRoom(800, { price: 10 })).toBe("10ch");
      });

      it("never holds less than six, and holds six for a series it knows nothing about", () => {
        expect(valueRoom(800, { price: 4 })).toBe("6ch");
        expect(valueRoom(800, { short: 9 })).toBe("6ch");
        expect(valueRoom(800, {})).toBe("6ch");
        expect(valueRoom(800, undefined)).toBe("6ch");
      });

      it("on a phone, holds none whatever the series can show: the row is the label's", () => {
        expect(valueRoom(400, { price: 9 })).toBe("");
      });

      it("gives each series the room of its own widest value", () => {
        const { container } = renderStrip(
          model({ entries: [entry(), entry({ id: "short", label: "Short %", value: "3.20%" })] }),
          { width: 800, valueChars: { price: 8, short: 7 } },
        );
        const rooms = Array.from(container.querySelectorAll("[data-readout-value]")).map(widthOf);
        expect(rooms).toEqual(["8ch", "7ch"]);
      });
    });

    it("on a phone, holds no room for a change that is not there: the row is the label's", () => {
      const { container } = renderStrip(model({ state: "hover" }), { width: 400 });
      expect(slots(container)).toHaveLength(0);
      expect(container.querySelector('[data-readout-entry]')!.children).toHaveLength(3); // dot, label, value
    });

    it("on one row, holds the room of the widest headline, so the entries after it keep their place", () => {
      const headlineWidth = (m: ReadoutModel, width: number) => {
        const r = renderStrip(m, { width });
        const w = (r.container.querySelector("[data-readout-headline]") as HTMLElement).style.minWidth;
        r.unmount();
        return w;
      };
      // "Latest · 1 June 2026", "29 Mar 2026" and a pin all hold 21 characters.
      expect(headlineWidth(model(), 800)).toBe("21ch");
      expect(headlineWidth(model({ state: "hover", headline: "29 Mar 2026" }), 800)).toBe("21ch");
      expect(headlineWidth(model({ state: "pinned", headline: "9 Oct 2026" }), 800)).toBe("21ch");
      // A measure's two dates hold 27.
      expect(
        headlineWidth(model({ state: "measure", headline: "1 Sep 2026 → 9 Oct 2026" }), 800),
      ).toBe("27ch");
      // On a phone the headline is alone on its row: nothing to hold.
      expect(headlineWidth(model(), 400)).toBe("");
    });

    it("gives way at the label first: it is the one part that shrinks and ends in an ellipsis", () => {
      const { container } = renderStrip(model({ entries: [entry({ change: delta(), dateNote: "5 Oct" })] }));
      const [dot, label, value, , note] = Array.from(
        container.querySelector('[data-readout-entry]')!.children,
      ) as HTMLElement[];
      expect(label!.className).toContain("truncate");
      expect(label!.className).toContain("min-w-0");
      for (const kept of [dot, value, note]) expect(kept!.className).toContain("shrink-0");
    });
  });

  describe("open, high, low and close", () => {
    const withOhlc = model({
      entries: [entry({ ohlc: { open: "41.00", high: "43.00", low: "40.00", close: "42.00" } })],
    });

    it("shows from 900px wide when the model has them", () => {
      const { container } = renderStrip(withOhlc, { width: 900 });
      expect(container.querySelector("[data-readout-ohlc]")!.textContent).toBe(
        "O 41.00 H 43.00 L 40.00 C 42.00",
      );
    });

    it("is absent under 900px, and when the model has none", () => {
      const narrow = renderStrip(withOhlc, { width: 899 });
      expect(narrow.container.querySelector("[data-readout-ohlc]")).toBeNull();
      narrow.unmount();
      const none = renderStrip(model(), { width: 1200 });
      expect(none.container.querySelector("[data-readout-ohlc]")).toBeNull();
    });
  });

  describe("the Pinned chip", () => {
    it("is shown only while pinned, with data-pinned", () => {
      const off = renderStrip(model(), { pinned: false });
      expect(off.container.querySelector("[data-readout-chip]")).toBeNull();
      expect(off.container.querySelector("[data-chart-readout]")!.hasAttribute("data-pinned")).toBe(false);
      off.unmount();

      const on = renderStrip(model({ state: "pinned" }), { pinned: true });
      expect(on.container.querySelector("[data-readout-chip]")!.textContent).toContain("Pinned");
      expect(on.container.querySelector("[data-chart-readout]")!.hasAttribute("data-pinned")).toBe(true);
    });

    it("has a labelled release button that explains the pin, and calls back once", () => {
      const onRelease = jest.fn();
      const { getByRole } = renderStrip(model({ state: "pinned" }), { pinned: true, onRelease });
      const button = getByRole("button", { name: "Release pinned reading" });
      expect(button.getAttribute("title")).toBe(
        "Tap the chart to move the reading; tap it again to release",
      );
      expect(button.getAttribute("type")).toBe("button");
      fireEvent.click(button);
      expect(onRelease).toHaveBeenCalledTimes(1);
    });

    it("sits with the headline on the first row when narrow, at the end of the one row when wide", () => {
      const narrow = renderStrip(model({ state: "pinned" }), { width: 360, pinned: true });
      const [first] = Array.from(narrow.container.querySelectorAll("[data-readout-row]"));
      expect(first!.querySelector("[data-readout-chip]")).not.toBeNull();
      narrow.unmount();

      const wide = renderStrip(model({ state: "pinned" }), { width: 800, pinned: true });
      const row = wide.container.querySelector("[data-readout-row]")!;
      expect(row.lastElementChild!.hasAttribute("data-readout-chip")).toBe(true);
    });
  });
});

describe("pinnedAnnouncement", () => {
  it("says the date and each series' value", () => {
    expect(
      pinnedAnnouncement(
        model({
          state: "pinned",
          headline: "6 Oct 2026",
          entries: [entry(), entry({ id: "short", label: "Short %", value: "3.20%" })],
        }),
      ),
    ).toBe("Pinned 6 Oct 2026: Price $43.21, Short % 3.20%");
  });

  it("says when a value is from another day", () => {
    expect(
      pinnedAnnouncement(
        model({
          state: "pinned",
          headline: "6 Oct 2026",
          entries: [entry(), entry({ id: "short", label: "Short %", value: "3.20%", dateNote: "2 Oct" })],
        }),
      ),
    ).toBe("Pinned 6 Oct 2026: Price $43.21, Short % 3.20% on 2 Oct");
  });

  it("leaves out a series that has no value", () => {
    expect(
      pinnedAnnouncement(
        model({
          state: "pinned",
          headline: "6 Oct 2026",
          entries: [entry(), entry({ id: "short", label: "Short %", value: null })],
        }),
      ),
    ).toBe("Pinned 6 Oct 2026: Price $43.21");
  });

  it("still says the date when no series has a value", () => {
    expect(
      pinnedAnnouncement(
        model({ state: "pinned", headline: "6 Oct 2026", entries: [entry({ value: null })] }),
      ),
    ).toBe("Pinned 6 Oct 2026");
  });
});

describe("ChartReadoutStrip: the session's volume", () => {
  const volume = { value: "1.2M", dateNote: null };
  const vol = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-readout-volume]");

  it("follows the series on one row, labelled, with the bars' explanation", () => {
    const { container } = renderStrip(model({ volume }), { width: 700 });
    const v = vol(container)!;
    expect(v).toBeTruthy();
    expect(v.textContent).toBe("Vol1.2M");
    expect(v.getAttribute("title")).toBe(VOLUME_EXPLAINER);
    expect(VOLUME_EXPLAINER).toMatch(/shares traded/i);
    // It is the last of the entries, after every series.
    const entries = container.querySelector("[data-readout-entries]")!;
    expect(entries.lastElementChild).toBe(v);
  });

  it("sits on the headline row of a phone strip, so it adds no row", () => {
    const width = 560;
    const { container } = renderStrip(model({ volume }), { width });
    const rows = container.querySelectorAll("[data-readout-row]");
    expect(within(rows[0] as HTMLElement).getByText("1.2M")).toBeTruthy();
    expect((container.firstElementChild as HTMLElement).style.height).toBe(
      `${readoutStripHeight(width, 1)}px`,
    );
  });

  it("keeps the room of the widest volume on one row, so a scrub moves nothing after it", () => {
    const { container } = renderStrip(model({ volume }), { width: 700 });
    const value = container.querySelector<HTMLElement>("[data-readout-volume-value]")!;
    expect(value.style.minWidth).toBe("7ch");
  });

  it("dates a volume from another day, and reads n/a for one not held", () => {
    const { container } = renderStrip(
      model({ volume: { value: null, dateNote: "5 Oct" } }),
      { width: 700 },
    );
    expect(vol(container)!.textContent).toBe("Voln/a· 5 Oct");
  });

  it("is absent when the chart draws no volume, and in a measure", () => {
    expect(vol(renderStrip(model(), { width: 700 }).container)).toBeNull();
    expect(
      vol(renderStrip(model({ state: "measure", volume }), { width: 700 }).container),
    ).toBeNull();
  });

  it("is announced with a pinned reading", () => {
    expect(
      pinnedAnnouncement(
        model({ state: "pinned", headline: "6 Oct 2026", volume }),
      ),
    ).toBe("Pinned 6 Oct 2026: Price $43.21, Volume 1.2M");
    expect(
      pinnedAnnouncement(
        model({
          state: "pinned",
          headline: "6 Oct 2026",
          volume: { value: "1.2M", dateNote: "5 Oct" },
        }),
      ),
    ).toBe("Pinned 6 Oct 2026: Price $43.21, Volume 1.2M on 5 Oct");
  });
});
