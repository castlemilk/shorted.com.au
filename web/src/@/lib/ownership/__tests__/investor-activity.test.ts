import { create } from "@bufbuild/protobuf";
import { SubstantialNoticeSchema } from "~/gen/shorts/v1alpha1/ownership_pb";
import { disclosureRow, type DisclosureRow } from "../investor-disclosures";
import {
  filingId,
  followedFilings,
  pointChange,
  selectFilings,
  watchCodes,
  type InvestorRegister,
} from "../investor-activity";
import { filerId } from "../named-filer";
import { investorPct } from "../australian-investors";

const name = "Mrs Georgina Hope Rinehart, Hancock Prospecting Pty Ltd";
const row = (
  code = "WCN",
  holderName = name,
  amendment: Partial<DisclosureRow> = {},
): DisclosureRow => ({
  ...disclosureRow(
    create(SubstantialNoticeSchema, {
      stockCode: code,
      holderName,
      form: "604",
      companyName: "White Cliff Minerals",
      announcedOn: "2026-10-10",
      event: "increased",
      previousPct: 10,
      presentPct: 12,
      hasPrevious: true,
      hasPresent: true,
      announcementUrl: "https://www.asx.com.au/1",
    }),
  ),
  ...amendment,
});
const selection = { query: "", event: "", order: "latest" as const };

it("follows a reviewed person across issuers while preserving issuer and full-name boundaries for every individual filing", () => {
  const a = row(),
    b = row("BM1"),
    amendment = row("WCN", name, { source: "https://www.asx.com.au/2" });
  const raw = row("RLC", "MR JOSHUA GORDON");
  const registers: InvestorRegister[] = [
    {
      code: "WCN",
      asOf: "2026-11-06",
      limited: false,
      notices: [
        a,
        amendment,
        a,
        row("WCN", "Bianca Hope Rinehart as trustee"),
        row("WCN", "Hancock Prospecting Pty Ltd"),
        row("WCN", raw.name),
      ],
    },
    { code: "BM1", asOf: "2026-11-06", limited: false, notices: [b] },
    {
      code: "RLC",
      asOf: "2026-11-06",
      limited: false,
      notices: [
        raw,
        row("RLC", "MR JOSHUA GORDON & ASSOCIATES"),
        row("WCN", name, { source: null }),
      ],
    },
  ];
  const people = [
    { id: "gina-rinehart", name: "Gina Rinehart" },
    { id: filerId("WCN", name), code: "WCN", name },
    {
      id: filerId("RLC", "MR JOSHUA GORDON"),
      code: "RLC",
      name: "Mr Joshua Gordon",
    },
  ];
  expect(watchCodes(people)).toEqual(["BM1", "RLC", "WCN"]);
  expect(followedFilings(registers, people)).toEqual([a, amendment, b, raw]);
  expect(filingId({ ...a, name: `  ${a.name.toUpperCase()}  ` })).toBe(
    filingId(a),
  );
  expect(filingId(a)).not.toBe(filingId(amendment));
  expect(filingId(row("WCN", name, { source: null, pct: 20 }))).not.toBe(
    filingId(row("WCN", name, { source: null, pct: 22 })),
  );
});
it("ranks comparable increases and decreases by absolute percentage points, with date tie breaks", () => {
  const down = row("DDD", name, { previous: 18, pct: 10, event: "decreased" });
  const up = row("UUU", name, { previous: 2, pct: 10, date: "2026-11-01" });
  const zero = row("ZZZ", name, { previous: 0, pct: 0, event: "changed" });
  const tiny = row("TNY", name, {
    previous: 2.0104,
    pct: 2.01,
    event: "decreased",
  });
  const fresh = row("NEW", name, {
    form: "603",
    event: "became",
    previous: 0,
    pct: 30,
  });
  const ceased = row("END", name, {
    form: "605",
    ceased: true,
    event: "changed",
    previous: 35,
    pct: null,
  });
  const missing = row("UNK", name, { previous: null, pct: 72 });
  expect(pointChange(tiny)).toBe(-0.0004);
  expect(investorPct(tiny.previous!)).toBe("2.0104%");
  expect([fresh, ceased, missing].map(pointChange)).toEqual([null, null, null]);
  const rows = [zero, ceased, down, fresh, missing, tiny, up];
  expect(selectFilings(rows, { ...selection, order: "move" })).toEqual([
    up,
    down,
    tiny,
    zero,
  ]);
  expect(selectFilings(rows, { ...selection, order: "power" })[0]).toBe(
    missing,
  );
  expect(selectFilings(rows, { ...selection, event: "ceased" })).toEqual([
    ceased,
  ]);
  expect(rows[0]).toBe(zero);
});

it("finds reviewed aliases, filed names, ticker and company in any word order without applying aliases to unrelated names", () => {
  const gina = row(),
    raw = row("WCN", "Bianca Hope Rinehart");
  expect(
    selectFilings([gina, raw], { ...selection, query: "WCN Gina" }),
  ).toEqual([gina]);
  expect(
    selectFilings([gina, raw], {
      ...selection,
      query: "Cliff   minerals Hancock",
      titled: true,
    }),
  ).toEqual([gina]);
  expect(
    selectFilings([gina, raw], { ...selection, query: "Rinehart" }),
  ).toHaveLength(2);
});
