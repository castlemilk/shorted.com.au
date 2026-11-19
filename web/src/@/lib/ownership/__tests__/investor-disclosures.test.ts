import { create } from "@bufbuild/protobuf";
import {
  GetStockOwnershipResponseSchema,
  SubstantialNoticeSchema,
} from "~/gen/shorts/v1alpha1/ownership_pb";
import {
  AUSTRALIAN_INVESTORS,
  RANKED_HOLDERS,
  investorBySlug,
  investorForFiling,
  ranksForInvestor,
} from "../australian-investors";
import {
  currentFilerRow,
  disclosureRow,
  readDiscovery,
  readFilingIdentity,
} from "../investor-disclosures";
import { filerHref } from "../named-filer";

const filedName = "Mrs Georgina Hope Rinehart, Hancock Prospecting Pty Ltd";
const other =
  "Bianca Hope Rinehart in her capacity as trustee of the Hope Margaret Hancock Trust*";
const base = {
  stockCode: "WCN",
  holderName: filedName,
  form: "604",
  announcedOn: "2026-10-27",
  hasPresent: true,
  presentPct: 13.04,
  announcementUrl: "https://www.asx.com.au/2",
};
const make = (overrides: Partial<typeof base> = {}) =>
  create(SubstantialNoticeSchema, { ...base, ...overrides });

it("keeps the company, trustee and issuer in the legal filing identity", () => {
  expect(
    investorForFiling(
      "WCN",
      "  MRS GEORGINA HOPE RINEHART,  HANCOCK PROSPECTING PTY LTD ",
    )?.slug,
  ).toBe("gina-rinehart");
  for (const name of [
    other,
    "Mrs Georgina Hope Rinehart",
    "Mrs Georgina Hope Rinehart, Hancock Prospecting",
  ])
    expect(investorForFiling("WCN", name)).toBeUndefined();
  expect(investorForFiling("ABC", filedName)).toBeUndefined();
  const data = create(GetStockOwnershipResponseSchema, {
    asOf: "2026-11-06",
    history: [make(), make({ holderName: other })],
    holders: [
      { stockCode: "WCN", holderName: other, votingPowerPct: 13.04 },
      { stockCode: "WCN", holderName: filedName, votingPowerPct: 13.04 },
    ],
    historyTotal: 103,
  });
  const r = readFilingIdentity(
    investorBySlug("gina-rinehart")!.filings[0]!,
    data,
  );
  expect(r.current?.name).toBe(filedName);
  expect(r.history).toHaveLength(1);
  expect(r.historyLimited).toBe(true);
});

it("tracks an annual-register name when that full name files at the same issuer", () => {
  const p = investorForFiling("HVN", "CHRISTOPHER HERBERT BROWN")!;
  expect(p.slug).toBe("hvn-christopher-herbert-brown");
  expect(investorForFiling("HVN", "Christopher Brown")).toBeUndefined();
  expect(
    investorForFiling("HVN", "Christopher Herbert Brown Pty Ltd"),
  ).toBeUndefined();
  expect(investorForFiling("ABC", "Christopher Herbert Brown")).toBeUndefined();
  const data = create(GetStockOwnershipResponseSchema, {
    holders: [
      {
        stockCode: "HVN",
        holderName: "Christopher Herbert Brown",
        votingPowerPct: 10,
      },
    ],
  });
  expect(readFilingIdentity(p.filings[0]!, data).current?.pct).toBe(10);
});

it("preserves the issuer rank, repeated accounts and joint identity", () => {
  expect(new Set(AUSTRALIAN_INVESTORS.map((p) => p.slug)).size).toBe(15);
  for (const r of RANKED_HOLDERS)
    expect(investorBySlug(r.profile)).toBeDefined();
  expect(
    ranksForInvestor("richard-white").map((r) => [r.rank, r.shares]),
  ).toEqual([
    [1, 92675710],
    [12, 2602606],
  ]);
  expect(ranksForInvestor("wesley-and-emma-maas").map((r) => r.rank)).toEqual([
    6, 10, 18, 19,
  ]);
  expect(investorForFiling("MGH", "Wesley Jon Maas")).toBeUndefined();
  expect(filerHref("MGH", "A&B / C + Sons")).toBe(
    "/ownership/traders/asx/MGH/holders?name=A%26B+%2F+C+%2B+Sons",
  );
});

it("reads the whole window, discards superseded notices across pages and preserves separate names on a shared PDF", async () => {
  const ceased = make({
    form: "605",
    announcementUrl: "https://www.asx.com.au/3",
  });
  const pages = jest
    .fn()
    .mockResolvedValueOnce({
      asOf: "2026-11-06",
      total: 3,
      nextCursor: "next",
      notices: [
        ceased,
        make({ holderName: other, announcementUrl: ceased.announcementUrl }),
      ],
    })
    .mockResolvedValueOnce({
      asOf: "2026-11-06",
      total: 3,
      nextCursor: "",
      notices: [make()],
    });
  const feed = await readDiscovery(pages);
  expect(pages.mock.calls).toEqual([[""], ["next"]]);
  expect(feed).toMatchObject({ status: "complete", read: 3, total: 3 });
  expect(feed.rows.map((r) => [r.name, r.ceased, r.pct])).toEqual([
    [filedName, true, null],
    [other, false, 13.04],
  ]);
});

it("distinguishes zero, unstated and stopped reporting, and rejects invalid source links", () => {
  expect(disclosureRow(make({ presentPct: 0 })).pct).toBe(0);
  expect(disclosureRow(make({ hasPresent: false })).pct).toBeNull();
  expect(disclosureRow(make({ form: "605" })).pct).toBeNull();
  expect(
    disclosureRow(make({ announcementUrl: "javascript:nothing" })).source,
  ).toBeNull();
});
it("reports missing pages, repeated cursors and the six-page cap as partial", async () => {
  const page = {
    asOf: "2026-11-06",
    total: 900,
    nextCursor: "same",
    notices: [make()],
  };
  const repeat = jest.fn().mockResolvedValue(page);
  expect(await readDiscovery(repeat)).toMatchObject({
    status: "partial",
    read: 1,
  });
  expect(repeat).toHaveBeenCalledTimes(2);
  expect(
    await readDiscovery(
      jest.fn().mockResolvedValueOnce(page).mockResolvedValue(undefined),
    ),
  ).toMatchObject({ status: "partial", read: 1 });
  let cursor = 0;
  const busy = jest.fn(async () => ({ ...page, nextCursor: String(++cursor) }));
  expect((await readDiscovery(busy)).status).toBe("partial");
  expect(busy).toHaveBeenCalledTimes(6);
  expect((await readDiscovery(async () => undefined)).status).toBe(
    "unavailable",
  );
  expect(
    (
      await readDiscovery(async () => ({
        ...page,
        total: 0,
        nextCursor: "",
        notices: [],
      }))
    ).status,
  ).toBe("complete");
});

it("uses two visually reviewed forms when the upstream extraction lost decimal digits", () => {
  const older = make({
    stockCode: "MHC",
    holderName: "Eric Sondergaard",
    announcementUrl:
      "https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=03134187",
    form: "604",
    presentPct: 1,
  });
  older.event = "ceased";
  expect(disclosureRow(older)).toMatchObject({
    previous: 12.68,
    pct: 15.67,
    ceased: false,
    event: "increased",
  });
  const latest = {
    ...older,
    announcementUrl: older.announcementUrl.replace("03134187", "03144160"),
    presentPct: 80,
  };
  expect(disclosureRow(latest)).toMatchObject({
    previous: 15.67,
    pct: 12.8,
    event: "decreased",
    source:
      "https://announcements.asx.com.au/asxpdf/20260925/pdf/074jsy8zbzlsmc.pdf",
  });
  const interest = create(GetStockOwnershipResponseSchema, {
    holders: [{ ...latest, votingPowerPct: 80 }],
  }).holders[0]!;
  expect(currentFilerRow(interest)).toMatchObject({
    pct: 12.8,
    votes: "117,335,000",
  });
  for (const changed of [
    { stockCode: "NRX" },
    { holderName: "Other holder" },
    { form: "603" },
    { announcementUrl: "https://www.asx.com.au/different-pdf" },
  ]) {
    expect(
      disclosureRow({ ...latest, ...changed, event: "increased" }).pct,
    ).toBe(80);
  }
});
