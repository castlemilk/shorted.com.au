import { fireEvent, render, within } from "@testing-library/react";
import { ChartReadoutStrip, pinnedAnnouncement } from "../chart-readout-strip";
import type { ReadoutDelta, ReadoutEntry, ReadoutModel } from "../chart-readout";

const GREEN = "rgb(22, 163, 74)";
const RED = "rgb(220, 38, 38)";

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
  props: { width?: number; pinned?: boolean; onRelease?: () => void } = {},
) {
  return render(
    <ChartReadoutStrip
      model={m}
      width={props.width ?? 400}
      pinned={props.pinned ?? false}
      onRelease={props.onRelease ?? jest.fn()}
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

  it("takes its height from the width alone: 44px below 640, 28px from it", () => {
    const small = renderStrip(model(), { width: 639 });
    expect(small.container.querySelector<HTMLElement>("[data-chart-readout]")!.style.height).toBe("44px");
    small.unmount();
    const wide = renderStrip(model(), { width: 640 });
    expect(wide.container.querySelector<HTMLElement>("[data-chart-readout]")!.style.height).toBe("28px");
  });

  it("gives the two rows of the narrow strip the strip's height between them", () => {
    const { container } = renderStrip(model(), { width: 360, pinned: true });
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-readout-row]"));
    expect(rows.map((r) => r.style.height)).toEqual(["24px", "20px"]);
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
              change: delta({ value: -2.5, text: "-2.5%", tone: "down" }),
            }),
          ],
        }),
      );
      expect(changeOf(container, "+3.1%").style.color).toBe(GREEN);
      expect(changeOf(container, "-2.5%").style.color).toBe(RED);
    });

    it("takes no colour when flat", () => {
      const { container } = renderStrip(
        model({
          entries: [entry({ change: delta({ value: 0, text: "0.0%", tone: "flat" }) })],
        }),
      );
      expect(changeOf(container, "0.0%").style.color).toBe("");
    });

    it("keeps a percentage-point change in the foreground, with an arrow that is hidden from assistive technology", () => {
      const up = delta({ value: 0.21, text: "+0.21 pp", colored: false });
      const down = delta({ value: -1.1, text: "-1.10 pp", tone: "down", colored: false });
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
      for (const [text, arrow] of [
        ["+0.21 pp", "▲"],
        ["-1.10 pp", "▼"],
      ] as const) {
        const el = changeOf(container, text);
        expect(el.style.color).toBe("");
        expect(el.previousElementSibling!.textContent).toBe(arrow);
        expect(el.previousElementSibling!.getAttribute("aria-hidden")).toBe("true");
      }
      const flatEl = changeOf(container, "0.00 pp");
      expect(flatEl.style.color).toBe("");
      expect(flatEl.previousElementSibling).toBeNull();
    });

    it("is absent, with room kept for it, when the entry names no change", () => {
      const { container } = renderStrip(model({ state: "hover" }));
      expect(container.querySelector("[data-readout-change]")).toBeNull();
    });
  });

  describe("a value and its date", () => {
    it("shows a dash for a series with no value", () => {
      const { container } = renderStrip(model({ entries: [entry({ value: null })] }));
      expect(within(container).getByText("—")).toBeTruthy();
      expect(container.querySelector("[data-readout-entry]")!.textContent).toContain("Price");
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

    it("shows a dash for a series with no change to name", () => {
      const { container } = renderStrip(measure);
      const short = container.querySelector<HTMLElement>('[data-readout-entry="short"]')!;
      expect(within(short).getByText("—")).toBeTruthy();
    });
  });

  describe("the room each entry keeps", () => {
    const widthOf = (el: Element) => (el as HTMLElement).style.minWidth;
    const slots = (c: HTMLElement) =>
      Array.from(c.querySelectorAll<HTMLElement>('[data-readout-entry] > [style*="min-width: 9ch"]'));

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

    it("on one row, gives a value room for six characters, on two for five", () => {
      const wide = renderStrip(model(), { width: 800 });
      expect(widthOf(wide.container.querySelector("[data-readout-value]")!)).toBe("6ch");
      wide.unmount();
      const narrow = renderStrip(model(), { width: 400 });
      expect(widthOf(narrow.container.querySelector("[data-readout-value]")!)).toBe("5ch");
    });

    it("on two rows, holds no room for a change that is not there: the labels need it", () => {
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
      // On two rows the headline is alone on its row: nothing to hold.
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
