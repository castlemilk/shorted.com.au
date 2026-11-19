import {
  AUSTRALIAN_INVESTORS,
  TRACKED_ISSUERS,
} from "~/@/lib/ownership/australian-investors";
import {
  graphFilerNode,
  graphRecords,
  graphRows,
  issuerOfAccount,
  localGraphNode,
  scopedAccount,
} from "../ownership-graph";
import { profilePictures } from "../portraits";

it("makes each tracked issuer and investor reachable through a reviewed filing", () => {
  expect(new Set(graphRecords.map((r) => r.company.id))).toEqual(
    new Set(TRACKED_ISSUERS),
  );
  expect(new Set(graphRecords.map((r) => r.person.id))).toEqual(
    new Set(AUSTRALIAN_INVESTORS.map((p) => p.slug)),
  );
  for (const r of graphRecords)
    for (const node of [r.company, r.person, r.account, ...r.vehicles])
      expect(graphRows(node)).toContain(r);
});

it("preserves the two Shafer accounts and their separate quantities", () => {
  const rows = graphRows(localGraphNode("organisation", "shafer-corporation")!);
  expect(
    rows.map((r) => [r.person.name, r.company.id, r.rank, r.shares]),
  ).toEqual([
    ["David Shafer", "KGN", 5, 3075642],
    ["David Shafer", "KGN", 13, 300000],
  ]);
  expect(rows[0]!.account.id).not.toBe(rows[1]!.account.id);
  expect(graphFilerNode("KGN", "Shafer Corporation Pty Ltd")?.kind).toBe(
    "organisation",
  );
  expect(graphFilerNode("KGN", rows[0]!.account.name)?.id).toBe(
    rows[0]!.account.id,
  );
  expect(graphFilerNode("WTC", "Shafer Corporation Pty Ltd")).toBeUndefined();
});

it("scopes even uncurated names to an issuer and retains account qualifiers", () => {
  const a = scopedAccount("BHP", "Example Custodial <Client A/C>");
  expect(issuerOfAccount(a.id)).toBe("BHP");
  expect(a.id).toBe(scopedAccount("BHP", "EXAMPLE CUSTODIAL  <CLIENT A/C>").id);
  expect(a.id).not.toBe(scopedAccount("WES", a.name).id);
  expect(a.id).not.toBe(
    scopedAccount("BHP", "Example Custodial <The Client A/C>").id,
  );
  expect(issuerOfAccount("../../../")).toBeUndefined();
});

it("preserves group interests and restricts each registered parcel to its holder", () => {
  const joint = graphRows(
    localGraphNode("person", "andrew-and-nicola-forrest")!,
  );
  expect(joint).toHaveLength(1);
  expect(joint[0]).toMatchObject({
    value: "36.74%",
    vehicles: [{ id: "tattarang" }, { id: "minderoo-foundation" }],
  });
  const bb = graphRows(localGraphNode("organisation", "bbfit-investments")!);
  expect(bb.filter((r) => r.rank).map((r) => r.account.name)).toEqual([
    "BBFIT INVESTMENTS PTE LTD",
  ]);
  const ceased = graphRows(localGraphNode("person", "tolga-kumova")!);
  expect(ceased[0]).toMatchObject({
    document: "Form 605",
    unit: "Ceased to be substantial",
    value: undefined,
  });
});

it("links across issuers only when they identify the same organisation", () => {
  const rows = graphRows(
    localGraphNode("organisation", "hancock-prospecting")!,
  );
  expect(rows.map((r) => r.company.id)).toEqual(["BM1", "WCN"]);
  expect(rows.map((r) => r.identitySource)).toEqual(rows.map((r) => r.source));
  expect(rows[0]?.source).not.toBe(rows[1]?.source);
});

it("credits each photographed subject and keeps unidentified people photo-free", () => {
  const pair = profilePictures("andrew-and-nicola-forrest").map(
    (p) => p.subject,
  );
  expect(pair).toEqual(["Andrew Forrest", "Nicola Forrest"]);
  expect(profilePictures("david-shafer", "David Shafer")[0]).toMatchObject({
    subject: "David Shafer",
    credit: "Kogan.com",
  });
  expect(profilePictures("kgn-philippa-jacqueline-taplin")).toHaveLength(0);
});
