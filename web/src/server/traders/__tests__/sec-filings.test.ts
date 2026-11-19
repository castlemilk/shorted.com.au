/** @jest-environment node */
import { parse13F, recentPeriods, type Filing } from "../sec-filings";
import { getSecHoldings } from "../get-sec-holdings";
import verified from "../verified-filings.json";
import {
  adjacentQuarters,
  comparePositions,
} from "~/@/lib/ownership/quarterly-positions";

const cik = "0001541617";
const [latest, prior] = verified[cik];
const f = latest!.filing;
const row = `<infoTable><nameOfIssuer>A &amp; B</nameOfIssuer><titleOfClass>COM</titleOfClass><cusip>012345678</cusip><value>11</value>
  <shrsOrPrnAmt><sshPrnamt>3</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable>`;
const raw = `<SEC-DOCUMENT>${f.accession}.txt
<DOCUMENT><TYPE>13F-HR
<XML><edgarSubmission><headerData><submissionType>13F-HR</submissionType><filerInfo><filer><credentials><cik>${cik}</cik></credentials></filer></filerInfo></headerData>
<formData><coverPage><reportCalendarOrQuarter>09-30-2026</reportCalendarOrQuarter><reportType>13F HOLDINGS REPORT</reportType>
<filingManager><name>Example Manager</name></filingManager></coverPage><summaryPage><tableEntryTotal>1</tableEntryTotal><tableValueTotal>12</tableValueTotal>
<isConfidentialOmitted>false</isConfidentialOmitted></summaryPage></formData></edgarSubmission></XML></DOCUMENT>
<DOCUMENT><TYPE>INFORMATION TABLE
<XML><informationTable>${row}</informationTable></XML></DOCUMENT>`;

function submissions(filings: Filing[]) {
  return {
    cik,
    filings: {
      recent: {
        form: filings.map((v) => v.form),
        reportDate: filings.map((v) => v.period),
        filingDate: filings.map((v) => v.filed),
        accessionNumber: filings.map((v) => v.accession),
      },
    },
  };
}

describe("SEC filing identity and reporting periods", () => {
  it("uses the report period and keeps later amendments attached to that period", () => {
    const amendment = {
      ...prior!.filing,
      filed: "2026-11-17",
      form: "13F-HR/A",
      accession: "0001541617-26-000011",
    };
    expect(
      recentPeriods(submissions([amendment, f, prior!.filing]), cik),
    ).toEqual([[f], [amendment, prior!.filing]]);
    expect(() => recentPeriods(submissions([f]), "0001649339")).toThrow();
  });

  it("retains leading zeros and both stated values when the cover and table disagree", () => {
    const parsed = parse13F(raw, cik, f);
    expect(parsed.totalUsd).toBe(12);
    expect(parsed.positions[0]).toMatchObject({
      issuer: "A & B",
      cusip: "012345678",
      usd: 11,
      quantity: 3,
    });
    expect(parsed.confidentialOmitted).toBe(false);
  });

  it.each([
    ["a missing row", raw.replace("<tableEntryTotal>1", "<tableEntryTotal>2")],
    ["a mismatched quarter", raw.replace("09-30-2026", "06-30-2026")],
    ["a different accession", raw.replace(f.accession, "0001541617-26-999999")],
    [
      "a combination report",
      raw.replace("13F HOLDINGS REPORT", "13F COMBINATION REPORT"),
    ],
    ["an unknown unit", raw.replace(">SH<", ">OTHER<")],
    ["an unreported quantity", raw.replace("<sshPrnamt>3", "<sshPrnamt>")],
  ])("withholds %s", (_label, content) => {
    expect(() => parse13F(content, cik, f)).toThrow();
  });

  it("keeps the discrepancy in the real September Altimeter filing visible", () => {
    expect(
      latest!.totalUsd - latest!.positions.reduce((sum, p) => sum + p.usd, 0),
    ).toBe(344388);
  });
});

describe("13F lookup", () => {
  afterEach(() => jest.restoreAllMocks());
  it("keeps amended or notice-only periods linkable without substituting an earlier snapshot", async () => {
    const amendment = {
      ...f,
      form: "13F-HR/A",
      accession: "0001541617-26-000011",
    };
    const mock = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify(
            submissions([amendment, f, { ...prior!.filing, form: "13F-NT" }]),
          ),
        ),
      );
    const data = await getSecHoldings(cik);
    expect(data.archived).toBe(false);
    expect(data.periods.map((period) => period.snapshot)).toEqual([
      undefined,
      undefined,
    ]);
    expect(data.periods[0]!.filings).toHaveLength(2);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("reads a new accession and keeps an unavailable source distinct from an empty portfolio", async () => {
    const next = { ...f, accession: "0001541617-26-000012" };
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(submissions([next]))))
      .mockResolvedValueOnce(
        new Response(raw.replaceAll(f.accession, next.accession)),
      );
    expect((await getSecHoldings(cik)).periods[0]?.snapshot?.filing).toEqual(
      next,
    );
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(submissions([next]))))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    const period = (await getSecHoldings(cik)).periods[0];
    expect(period?.filings).toEqual([next]);
    expect(period?.snapshot).toBeUndefined();
    expect(period?.note).toMatch(/unavailable/);
  });

  it("labels saved filings on an index failure and keeps the original report dates", async () => {
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const archived = await getSecHoldings("0001649339");
    expect(archived.archived).toBe(true);
    expect(archived.periods.map((p) => p.snapshot?.filing.period)).toEqual([
      "2025-09-30",
      "2025-06-30",
    ]);
  });
});

describe("quarterly comparisons", () => {
  it("matches Altimeter's Cerebras shares across differently cased filed identifiers", () => {
    const rows = comparePositions(latest!, prior!);
    const cerebras = rows.filter(
      ({ current, previous }) =>
        (current ?? previous)?.cusip.toUpperCase() === "15675D103",
    );
    expect(cerebras).toHaveLength(1);
    expect(cerebras[0]).toMatchObject({
      current: { cusip: "15675D103", quantity: 5_953_504 },
      previous: { cusip: "15675d103", quantity: 7_225_037 },
    });
    expect(rows.filter(({ current }) => !current)).toHaveLength(6);
  });

  it("matches a class across quarters and keeps shares, principal and options separate", () => {
    const sample = latest!.positions[0]!;
    const compared = comparePositions(
      {
        ...latest!,
        positions: [
          { ...sample, quantity: 5 },
          { ...sample, quantity: 2 },
          { ...sample, option: "CALL" },
        ],
      },
      {
        ...prior!,
        positions: [
          { ...sample, quantity: 8 },
          { ...sample, unit: "PRN" },
          { ...sample, option: "PUT" },
        ],
      },
    );
    expect(compared).toHaveLength(4);
    expect(
      compared.find((p) => p.current?.quantity === 7)?.previous?.quantity,
    ).toBe(8);
    expect(
      compared.find((p) => p.previous?.option === "PUT")?.current,
    ).toBeUndefined();
    expect(
      compared.find((p) => p.current?.option === "CALL")?.previous,
    ).toBeUndefined();
    expect(adjacentQuarters("2025-12-31", "2026-03-31")).toBe(true);
    expect(adjacentQuarters("2025-09-30", "2026-03-31")).toBe(false);
  });
});
