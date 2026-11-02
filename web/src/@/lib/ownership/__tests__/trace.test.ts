import type { SubstantialHolding, SubstantialNotice } from "~/gen/shorts/v1alpha1/ownership_pb";
import { buildHolderLanes, type HolderLane } from "../trace";

const ASOF = "2026-10-31";
const DAY_MS = 86_400_000;

/** The date `days` before `iso`, so the tests never count days by hand. */
const daysBefore = (iso: string, days: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);

// With the as-at date on 31 October, a register shorter than 180 days runs from
// 4 May, so these are the x coordinates (days after 4 May, over 180, times 1000).
const X = {
  sep1: "666.67",
  oct1: "833.33",
  oct10: "883.33",
  oct15: "911.11",
  oct20: "938.89",
};

const holding = (over: Partial<SubstantialHolding> = {}): SubstantialHolding =>
  ({
    stockCode: "BHP",
    companyName: "BHP Group Limited",
    industry: "Materials",
    holderKey: "k1",
    holderName: "Holder One",
    institutionSlug: "",
    kind: "unclassified",
    form: "603",
    votingPowerPct: 6.2,
    previousPct: 0,
    hasPrevious: false,
    eventDate: "2026-10-01",
    announcedOn: "2026-10-02",
    announcementUrl: "https://www.asx.com.au/holder-one.pdf",
    ...over,
  }) as unknown as SubstantialHolding;

const notice = (over: Partial<SubstantialNotice> = {}): SubstantialNotice =>
  ({
    stockCode: "BHP",
    companyName: "BHP Group Limited",
    holderKey: "k1",
    holderName: "Holder One",
    institutionSlug: "",
    kind: "unclassified",
    form: "603",
    presentPct: 6.2,
    hasPresent: true,
    previousPct: 0,
    hasPrevious: false,
    ceased: false,
    eventDate: "2026-10-01",
    announcedOn: "2026-10-02",
    announcementUrl: "https://www.asx.com.au/notice.pdf",
    ...over,
  }) as unknown as SubstantialNotice;

/** A cessation: Form 605, under 5%, no figure stated. */
const cease = (over: Partial<SubstantialNotice> = {}): SubstantialNotice =>
  notice({ form: "605", ceased: true, hasPresent: false, presentPct: 0, ...over });

const build = (holders: SubstantialHolding[], history: SubstantialNotice[], asOf = ASOF) =>
  buildHolderLanes({ holders, history, asOf, historyTotal: history.length });

const laneOf = (lanes: HolderLane[], key: string): HolderLane => {
  const lane = lanes.find((l) => l.holderKey === key);
  if (!lane) throw new Error(`no lane for ${key}`);
  return lane;
};

/** The y of every point a solid run reaches: the M of each run and each V. */
const solidYs = (lane: HolderLane): number[] =>
  lane.paths.solid.flatMap((d) => [...d.matchAll(/(?:M[\d.]+ |V)([\d.]+)/g)].map((m) => Number(m[1])));

describe("buildHolderLanes: the path rules", () => {
  it("starts a 603 on the threshold, rises to its figure and runs on to the as-at date", () => {
    const lane = laneOf(build([holding()], [notice()]).lanes, "k1");
    expect(lane.paths.solid).toEqual([`M${X.oct1} 23V15`]);
    expect(lane.paths.dotted).toEqual([`M${X.oct1} 15H1000`]);
    expect(lane.paths.ticks).toEqual([`M${X.oct1} 12V18`]);
    expect(lane.paths.ends).toEqual([]);
    expect(lane.scaleHi).toBe(8);
  });

  it("draws a 604 from a 40-unit dotted lead-in at the figure it changed from", () => {
    const lane = laneOf(
      build(
        [holding({ form: "604", hasPrevious: true, previousPct: 6.5 })],
        [notice({ form: "604", hasPrevious: true, previousPct: 6.5 })],
      ).lanes,
      "k1",
    );
    expect(lane.paths.dotted).toEqual(["M793.33 13H833.33", "M833.33 15H1000"]);
    expect(lane.paths.solid).toEqual([`M${X.oct1} 13V15`]);
    expect(lane.change).toBe("−0.30 pp");
  });

  it("ends an open line on the threshold with an end-stop, and never lifts it above the band", () => {
    const lane = laneOf(
      build([], [notice({ holderKey: "x" }), cease({ holderKey: "x", eventDate: "2026-10-15" })]).lanes,
      "x",
    );
    expect(lane.ceased).toBe(true);
    expect(lane.paths.solid).toEqual([`M${X.oct1} 23V15H${X.oct15}V23`]);
    expect(lane.paths.ends).toEqual([`M${X.oct15} 20V26`]);
    expect(lane.paths.dotted).toEqual([]);
    expect(Math.min(...solidYs(lane))).toBeGreaterThanOrEqual(3);
    expect(Math.max(...solidYs(lane))).toBeLessThanOrEqual(23);
  });

  it("draws a lone cessation as a 12-unit stub and an end-stop, with no solid path", () => {
    const lane = laneOf(build([], [cease({ holderKey: "x", eventDate: "2026-10-15" })]).lanes, "x");
    expect(lane.paths.solid).toEqual([]);
    expect(lane.paths.dotted).toEqual([`M899.11 23H${X.oct15}`]);
    expect(lane.paths.ends).toEqual([`M${X.oct15} 20V26`]);
    expect(lane.figure).toBe("under 5%");
    expect(lane.change).toBe("Ceased");
  });

  it("draws a 603, 605, 603 cycle as two solid runs with a gap between them", () => {
    // DRO's Citigroup shape: out, and back in.
    const lane = laneOf(
      build(
        [holding({ eventDate: "2026-10-20" })],
        [
          notice({ eventDate: "2026-10-20" }),
          cease({ eventDate: "2026-10-10" }),
          notice({ eventDate: "2026-10-01" }),
        ],
      ).lanes,
      "k1",
    );
    expect(lane.paths.solid).toEqual([`M${X.oct1} 23V15H${X.oct10}V23`, `M${X.oct20} 23V15`]);
    expect(lane.paths.dotted).toEqual([`M${X.oct20} 15H1000`]);
    expect(lane.paths.ticks).toEqual([`M${X.oct1} 12V18`, `M${X.oct20} 12V18`]);
    expect(lane.paths.ends).toEqual([`M${X.oct10} 20V26`]);
    expect(lane.notices).toBe(3);
  });

  it("draws a 1 percentage point step as a visible rise on a lane of 6.5% or less", () => {
    const lane = laneOf(
      build(
        [holding({ votingPowerPct: 6.5, form: "604", hasPrevious: true, previousPct: 5.5, eventDate: "2026-10-01" })],
        [
          notice({ form: "603", presentPct: 5.5, eventDate: "2026-09-01" }),
          notice({ form: "604", presentPct: 6.5, hasPrevious: true, previousPct: 5.5, eventDate: "2026-10-01" }),
        ],
      ).lanes,
      "k1",
    );
    expect(lane.scaleHi).toBe(8);
    expect(lane.paths.solid).toEqual([`M${X.sep1} 23V19.67H${X.oct1}V13`]);
    const [before, after] = solidYs(lane).slice(1);
    expect((before ?? 0) - (after ?? 0)).toBeGreaterThanOrEqual(4);
  });

  // Documented, not a goal: on a 25% holder a point is under a unit tall, and
  // the Notices table carries the small steps.
  it("draws a 1 point step on a 25% holder under one unit tall", () => {
    const lane = laneOf(
      build(
        [holding({ votingPowerPct: 25, form: "604", hasPrevious: true, previousPct: 24, eventDate: "2026-10-01" })],
        [
          notice({ form: "603", presentPct: 24, eventDate: "2026-09-01" }),
          notice({ form: "604", presentPct: 25, hasPrevious: true, previousPct: 24, eventDate: "2026-10-01" }),
        ],
      ).lanes,
      "k1",
    );
    expect(lane.scaleHi).toBe(27.5);
    expect(lane.paths.solid).toEqual([`M${X.sep1} 23V6.11H${X.oct1}V5.22`]);
  });

  it("scales a lane to 8% for a 5.2% holder and to 27.5% for a 25% holder", () => {
    expect(laneOf(build([holding({ holderKey: "small", votingPowerPct: 5.2 })], []).lanes, "small").scaleHi).toBe(8);
    expect(laneOf(build([holding({ holderKey: "big", votingPowerPct: 25 })], []).lanes, "big").scaleHi).toBe(27.5);
  });

  it("draws nothing for a notice that states no figure, and counts it", () => {
    const lane = laneOf(
      build(
        [holding({ eventDate: "2026-10-01" })],
        [notice(), notice({ form: "604", hasPresent: false, presentPct: 0, eventDate: "2026-10-10" })],
      ).lanes,
      "k1",
    );
    expect(lane.withoutFigure).toBe(1);
    expect(lane.notices).toBe(2);
    expect(lane.paths.solid).toEqual([`M${X.oct1} 23V15`]);
    expect(lane.paths.dotted).toEqual([`M${X.oct1} 15H1000`]);
  });

  it("counts a notice with no readable date without drawing it", () => {
    const lane = laneOf(build([], [notice({ holderKey: "x", eventDate: "", announcedOn: "" })]).lanes, "x");
    expect(lane.notices).toBe(1);
    expect(lane.paths.solid).toEqual([]);
    expect(lane.paths.dotted).toEqual([]);
  });

  it("never writes NaN or undefined into a path, a scale or an axis label", () => {
    const { lanes, yearLabels } = build(
      [holding({ holderKey: "k1" }), holding({ holderKey: "k2", eventDate: "", announcedOn: "" })],
      [
        notice({ holderKey: "k1", form: "604", hasPrevious: true, previousPct: 5.5, presentPct: 6.5 }),
        cease({ holderKey: "k3" }),
        notice({ holderKey: "k4", eventDate: "", announcedOn: "" }),
      ],
    );
    for (const lane of lanes) {
      const paths = [...lane.paths.solid, ...lane.paths.dotted, ...lane.paths.ticks, ...lane.paths.ends];
      for (const d of paths) expect(d).not.toMatch(/NaN|undefined/);
      expect(Number.isFinite(lane.scaleHi)).toBe(true);
    }
    for (const label of yearLabels) expect(Number.isFinite(label.x)).toBe(true);
  });
});

describe("buildHolderLanes: which lanes there are", () => {
  it("seeds a current holder whose notices are older than the history window, and flags it", () => {
    const lane = laneOf(build([holding({ eventDate: "2026-10-01" })], []).lanes, "k1");
    expect(lane.seeded).toBe(true);
    expect(lane.current).toBe(true);
    expect(lane.notices).toBe(0);
    expect(lane.paths.solid).toEqual([`M${X.oct1} 23V15`]);
    expect(lane.figure).toBe("6.20%");
  });

  it("draws each ceased holder off the register, most recent cessation first", () => {
    const { lanes } = build(
      [],
      [
        cease({ holderKey: "a", holderName: "Alpha", eventDate: "2026-10-20" }),
        cease({ holderKey: "b", holderName: "Bravo", eventDate: "2026-10-25" }),
      ],
    );
    expect(lanes.map((l) => l.holderKey)).toEqual(["b", "a"]);
    expect(lanes.map((l) => l.name)).toEqual(["Bravo", "Alpha"]);
    expect(lanes.every((l) => l.ceased && !l.current)).toBe(true);
    expect(lanes.map((l) => l.figure)).toEqual(["under 5%", "under 5%"]);
  });

  it("draws current holders in the order the API lists them, then the ceased ones", () => {
    const { lanes } = build(
      [holding({ holderKey: "z", holderName: "Zed" }), holding({ holderKey: "m", holderName: "Em" })],
      [cease({ holderKey: "q", holderName: "Queue" })],
    );
    expect(lanes.map((l) => l.holderKey)).toEqual(["z", "m", "q"]);
  });

  it("groups by holder_key, never by name", () => {
    const { lanes } = build(
      [holding({ holderKey: "asic:a", holderName: "Citigroup Global Markets" }), holding({ holderKey: "asic:b", holderName: "Citigroup Global Markets" })],
      [notice({ holderKey: "asic:a" }), notice({ holderKey: "asic:b", eventDate: "2026-10-05" })],
    );
    expect(lanes).toHaveLength(2);
    expect(lanes.map((l) => l.notices)).toEqual([1, 1]);
  });

  it("names an unnamed holder, and links a holder only where the map allows", () => {
    const { lanes } = build(
      [holding({ holderKey: "v", holderName: "", institutionSlug: "vanguard" }), holding({ holderKey: "asx:SFR", holderName: "Swift TV", institutionSlug: "" })],
      [],
    );
    expect(laneOf(lanes, "v").name).toBe("Unnamed holder");
    expect(laneOf(lanes, "v").href).toBe("/ownership/vanguard");
    expect(laneOf(lanes, "asx:SFR").href).toBe("/shorts/SFR/company");
  });
});

describe("buildHolderLanes: the axis and the ages", () => {
  it("widens a register on one day to 180 days, ending on the as-at date", () => {
    const { from, to } = build([], [cease({ holderKey: "x", eventDate: "2026-10-30" })]);
    expect(to).toBe(ASOF);
    expect(from).toBe(daysBefore(ASOF, 180));
  });

  it("starts the axis on the first drawn reading when it spans more than 180 days", () => {
    const { from, to } = build([], [cease({ holderKey: "x", eventDate: "2025-01-01" })]);
    expect(from).toBe("2025-01-01");
    expect(to).toBe(ASOF);
  });

  it("ends the axis on the latest reading when the as-at date does not read", () => {
    const { to } = build([], [notice({ holderKey: "x", eventDate: "2026-10-01" })], "");
    expect(to).toBe("2026-10-01");
  });

  it("labels each 1 January on the axis, and only those", () => {
    const { yearLabels, from } = build([], [cease({ holderKey: "x", eventDate: "2025-01-01" })]);
    expect(from).toBe("2025-01-01");
    expect(yearLabels.map((y) => y.label)).toEqual(["2025", "2026"]);
    expect(yearLabels[0]?.x).toBe(0);
    expect(yearLabels[1]?.x).toBeCloseTo(546.41, 1);
  });

  it("ages a lane more than 90 days past its reading, and not before", () => {
    expect(laneOf(build([holding({ eventDate: daysBefore(ASOF, 425) })], []).lanes, "k1").age).toBe("14 mo");
    expect(laneOf(build([holding({ eventDate: daysBefore(ASOF, 30) })], []).lanes, "k1").age).toBe("");
  });

  it("reports the history as truncated only when it holds fewer notices than the register has", () => {
    const history = [notice()];
    expect(buildHolderLanes({ holders: [], history, asOf: ASOF, historyTotal: 1 }).truncated).toBe(false);
    expect(buildHolderLanes({ holders: [], history, asOf: ASOF, historyTotal: 250 }).truncated).toBe(true);
  });
});
