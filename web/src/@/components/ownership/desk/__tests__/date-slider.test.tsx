/// <reference types="jest" />

/**
 * The index fund window's date slider (spec 13.5). The rules the handles obey are
 * pure and pinned directly; the component is pinned for what a keyboard and a
 * screen reader get: each handle is a slider whose value text is its date, the
 * arrow keys move one snapshot, and the later handle never crosses the earlier.
 */

import { fireEvent, render, screen } from "@testing-library/react";

import { DateSlider, movePair, shownSnapshotDates, snapshotIndex } from "../date-slider";

const DATES = ["2026-08-31", "2026-09-30", "2026-10-31"];

describe("movePair", () => {
  it("keeps the earlier handle before the later one and the later after the earlier", () => {
    expect(movePair(3, { from: 0, to: 2 }, "from", 5)).toEqual({ from: 1, to: 2 });
    expect(movePair(3, { from: 0, to: 2 }, "to", -4)).toEqual({ from: 0, to: 1 });
    expect(movePair(3, { from: 0, to: 2 }, "from", -1)).toEqual({ from: 0, to: 2 });
  });

  it("returns the pair unchanged when there are fewer than two snapshots", () => {
    expect(movePair(1, { from: 0, to: 0 }, "to", 3)).toEqual({ from: 0, to: 0 });
  });
});

describe("snapshotIndex", () => {
  it("finds a snapshot, and reads any other date to the newest snapshot on or before it", () => {
    expect(snapshotIndex(DATES, "2026-09-30")).toBe(1);
    expect(snapshotIndex(DATES, "2026-10-15")).toBe(1);
    expect(snapshotIndex(DATES, "2026-07-01")).toBe(0);
  });
});

describe("DateSlider", () => {
  it("names each handle and gives its date as the value text", () => {
    render(<DateSlider dates={DATES} from="2026-09-30" to="2026-10-31" label="Snapshots" onChange={() => undefined} />);
    const earlier = screen.getByRole("slider", { name: "Earlier snapshot" });
    const later = screen.getByRole("slider", { name: "Later snapshot" });
    expect(earlier).toHaveAttribute("aria-valuetext", "2026-09-30");
    expect(later).toHaveAttribute("aria-valuetext", "2026-10-31");
    expect(later).toHaveAttribute("aria-valuemax", "2");
    expect(screen.getByRole("group", { name: "Snapshots" })).toBeInTheDocument();
  });

  it("moves one snapshot per arrow key, and Home and End stop at the range each handle may take", () => {
    const onChange = jest.fn();
    render(<DateSlider dates={DATES} from="2026-08-31" to="2026-10-31" label="Snapshots" onChange={onChange} />);
    const earlier = screen.getByRole("slider", { name: "Earlier snapshot" });
    const later = screen.getByRole("slider", { name: "Later snapshot" });

    fireEvent.keyDown(earlier, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("2026-09-30", "2026-10-31");

    fireEvent.keyDown(later, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("2026-08-31", "2026-09-30");

    fireEvent.keyDown(earlier, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("2026-09-30", "2026-10-31");

    onChange.mockClear();
    // The later handle is already at the newest snapshot, and the earlier one at the oldest.
    fireEvent.keyDown(later, { key: "ArrowRight" });
    fireEvent.keyDown(earlier, { key: "ArrowLeft" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is read-only without a change handler: no tab stop, and disabled to assistive tech", () => {
    const onChange = jest.fn();
    render(<DateSlider dates={DATES} from="2026-08-31" to="2026-10-31" label="Snapshots" />);
    const earlier = screen.getByRole("slider", { name: "Earlier snapshot" });
    expect(earlier).toHaveAttribute("tabindex", "-1");
    expect(earlier).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(earlier, { key: "ArrowRight" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("draws nothing with fewer than two snapshot dates", () => {
    const { container } = render(<DateSlider dates={["2026-10-31"]} from="2026-10-31" to="2026-10-31" label="Snapshots" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("shownSnapshotDates", () => {
  it("names the dates the handles show, so a caption and the slider agree", () => {
    // An inverted link reads in order.
    expect(shownSnapshotDates(DATES, "2026-10-31", "2026-08-31")).toEqual({ from: "2026-08-31", to: "2026-10-31" });
    // A pair that snaps to one snapshot widens to the next, as the handles do.
    expect(shownSnapshotDates(DATES, "2026-08-31", "2026-08-31")).toEqual({ from: "2026-08-31", to: "2026-09-30" });
  });

  it("returns a link with no dates, or fewer than two snapshots, as it is", () => {
    expect(shownSnapshotDates(DATES, "", "")).toEqual({ from: "", to: "" });
    expect(shownSnapshotDates(["2026-10-31"], "2026-10-31", "2026-10-31")).toEqual({ from: "2026-10-31", to: "2026-10-31" });
  });
});
