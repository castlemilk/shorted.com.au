import type { SubstantialHolding } from "~/gen/shorts/v1alpha1/ownership_pb";
import { holdingRow } from "../rows";
import { ageLabel, ageMonths, dateOf, dayOf } from "../age";

const ASOF = "2026-10-31";
const DAY_MS = 86_400_000;

/** The date `days` before `iso`, so the tests count days without arithmetic by hand. */
const daysBefore = (iso: string, days: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);

describe("ageLabel", () => {
  it("prints nothing for a reading up to 90 days old", () => {
    expect(ageLabel(daysBefore(ASOF, 90), ASOF)).toBe("");
    expect(ageLabel(ASOF, ASOF)).toBe("");
  });

  it("counts whole months once a reading is older than 90 days", () => {
    expect(ageLabel(daysBefore(ASOF, 91), ASOF)).toBe("3 mo");
    expect(ageLabel(daysBefore(ASOF, 400), ASOF)).toBe("13 mo");
  });

  it("prints nothing when either date does not read", () => {
    expect(ageLabel("", ASOF)).toBe("");
    expect(ageLabel(daysBefore(ASOF, 400), "")).toBe("");
    expect(ageLabel("2026-02-31", ASOF)).toBe("");
    expect(ageLabel("31/10/2026", ASOF)).toBe("");
  });

  it("prints nothing for a reading dated after the as-at date", () => {
    expect(ageLabel("2026-11-30", ASOF)).toBe("");
  });
});

describe("ageMonths", () => {
  it("returns the months the label prints, or null when it prints none", () => {
    expect(ageMonths(daysBefore(ASOF, 400), ASOF)).toBe(13);
    expect(ageMonths(daysBefore(ASOF, 90), ASOF)).toBeNull();
    expect(ageMonths("", ASOF)).toBeNull();
  });
});

describe("dayOf and dateOf", () => {
  it("round-trip a real date and reject one the calendar does not have", () => {
    const day = dayOf("2026-10-31");
    expect(day).not.toBeNull();
    expect(dateOf(day ?? 0)).toBe("2026-10-31");
    expect(dayOf("2026-02-29")).toBeNull();
    expect(dayOf("2026-1-5")).toBeNull();
  });
});

describe("holdingRow age", () => {
  const holding = (over: Partial<SubstantialHolding> = {}): SubstantialHolding =>
    ({
      stockCode: "DRO",
      companyName: "DroneShield Limited",
      industry: "Industrials",
      holderKey: "asic:citigroup",
      holderName: "Citigroup Global Markets",
      institutionSlug: "",
      kind: "bank_broker",
      form: "604",
      votingPowerPct: 6.2,
      previousPct: 5.1,
      hasPrevious: true,
      eventDate: daysBefore(ASOF, 400),
      announcedOn: daysBefore(ASOF, 399),
      announcementUrl: "https://www.asx.com.au/n.pdf",
      ...over,
    }) as unknown as SubstantialHolding;

  it("ages a holding against the as-at date it is given", () => {
    const row = holdingRow(holding(), ASOF);
    expect(row.asAt).toBe(daysBefore(ASOF, 400));
    expect(row.age).toBe("13 mo");
  });

  it("carries no age for a recent holding", () => {
    expect(holdingRow(holding({ eventDate: daysBefore(ASOF, 30) }), ASOF).age).toBe("");
  });

  // The institution page calls rows.map(holdingRow), so the index arrives as
  // the second argument. It must not age the holding.
  it("carries no age when no as-at date is given, including through map", () => {
    expect(holdingRow(holding()).age).toBe("");
    expect([holding()].map(holdingRow)[0]?.age).toBe("");
  });
});
