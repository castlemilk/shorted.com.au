/// <reference types="jest" />

import { holderReading, NEW_WINDOW_DAYS, type HolderReadingPosition } from "../holder-reading";

const BANK: HolderReadingPosition = {
  industry: "Banks",
  votingPowerPct: 6,
  marketCap: 100e9,
  form: "603",
  eventDate: "2026-10-27",
};
const MINER: HolderReadingPosition = {
  industry: "Materials",
  votingPowerPct: 5,
  marketCap: 50e9,
  form: "604",
  eventDate: "2026-10-01",
};
const ENERGY: HolderReadingPosition = {
  industry: "Energy",
  votingPowerPct: 7,
  marketCap: 20e9,
  form: "603",
  eventDate: "2026-07-28",
};

describe("holderReading (spec 14.1, backlog C1)", () => {
  it("says the positions, the new ones in the window of the newest notice, and the largest sector", () => {
    expect(holderReading({ count: 172, positions: [BANK, MINER, ENERGY] })).toBe(
      "172 positions, 2 new this quarter, largest in Banks.",
    );
  });

  it("counts a new position up to the window's last day, and not one day beyond it", () => {
    expect(NEW_WINDOW_DAYS).toBe(91);
    const beyond = { ...ENERGY, eventDate: "2026-07-27" };
    expect(holderReading({ count: 172, positions: [BANK, MINER, beyond] })).toBe(
      "172 positions, 1 new this quarter, largest in Banks.",
    );
  });

  it("counts a position by its release date when one is stated, and not by its event date", () => {
    // Released within the window although the event was earlier: new.
    expect(holderReading({ count: 172, positions: [BANK, MINER, { ...ENERGY, announcedOn: "2026-10-01" }] })).toBe(
      "172 positions, 2 new this quarter, largest in Banks.",
    );
    // Released outside the window although the event date is inside it: not new.
    expect(
      holderReading({ count: 172, positions: [BANK, MINER, { ...ENERGY, announcedOn: "2026-06-01", eventDate: "2026-10-01" }] }),
    ).toBe("172 positions, 1 new this quarter, largest in Banks.");
  });

  it("leaves the new clause out unless every position carries its form and date", () => {
    const unformed = { ...BANK, form: undefined };
    expect(holderReading({ count: 172, positions: [unformed, MINER, ENERGY] })).toBe("172 positions, largest in Banks.");
    const undated = { ...ENERGY, eventDate: undefined };
    expect(holderReading({ count: 172, positions: [BANK, MINER, undated] })).toBe("172 positions, largest in Banks.");
  });

  it("drops the new clause when none of the positions is new, rather than printing 0", () => {
    expect(holderReading({ count: 3, positions: [MINER, { ...ENERGY, form: "604" }] })).toBe(
      "3 positions, largest in Materials.",
    );
  });

  it("ranks the largest by voting power when no position has a market cap to estimate an exposure from", () => {
    const unpriced = [
      { ...BANK, marketCap: null },
      { ...MINER, marketCap: null },
      { ...ENERGY, marketCap: null },
    ];
    // The new clause still counts from the rows' own forms and dates; only the ranking changes measure.
    expect(holderReading({ count: 1, positions: unpriced })).toBe("1 position, 2 new this quarter, largest in Energy.");
    expect(holderReading({ count: 1, positions: unpriced.map((position) => ({ ...position, form: "604" })) })).toBe(
      "1 position, largest in Energy.",
    );
  });

  it("names one position in the singular, and keeps the sector when the count is withheld", () => {
    expect(holderReading({ count: 1, positions: [BANK] })).toBe("1 position, 1 new this quarter, largest in Banks.");
    expect(holderReading({ count: 0, positions: [BANK] })).toBe("1 new this quarter, largest in Banks.");
  });

  it("has no reading for a holder with no position on record", () => {
    expect(holderReading({ count: 0, positions: [] })).toBeUndefined();
  });
});
