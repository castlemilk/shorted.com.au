import { createHash } from "node:crypto";
import {
  AUSTRALIAN_INVESTORS,
  RANKED_HOLDERS,
  filedNameKey,
  investorBySlug,
  investorPct,
} from "~/@/lib/ownership/australian-investors";
import { graphHref, type GraphKind } from "~/@/lib/ownership/graph-links";
import { TRADERS } from "~/@/lib/ownership/traders";
import { professionalRecord } from "./profile-metadata";

export type GraphNode = { kind: GraphKind; id: string; name: string };
export type GraphRecord = {
  person: GraphNode;
  company: GraphNode;
  account: GraphNode;
  vehicles: GraphNode[];
  source: string;
  document: string;
  identitySource: string;
  date?: string;
  yearEnd?: boolean;
  rank?: number;
  value?: string;
  unit: string;
  shares?: number;
};

const names: Record<string, string> = {
  WCN: "White Cliff Minerals",
  BM1: "Ballard Mining",
  "1AD": "AdAlta",
  RLC: "Reedy Lagoon Corporation",
};
const companies = new Map<string, GraphNode>();
const accounts = new Map<string, GraphNode>();
const people = new Map<string, GraphNode>();
const vehicles = new Map<string, GraphNode>();

// Only enumerate organisations the linked filing expressly connects. A printed
// nominee name or common surname is insufficient to join two share registers.
const vehicleSources: ReadonlyArray<{
  person: string;
  code: string;
  names: Array<[string, string]>;
}> = [
  {
    person: "ruslan-kogan",
    code: "KGN",
    names: [["kogan-management", "Kogan Management Pty Ltd"]],
  },
  {
    person: "david-shafer",
    code: "KGN",
    names: [["shafer-corporation", "Shafer Corporation Pty Ltd"]],
  },
  {
    person: "andrew-and-nicola-forrest",
    code: "FMG",
    names: [
      ["tattarang", "Tattarang Pty Ltd"],
      ["minderoo-foundation", "Minderoo Foundation Limited"],
    ],
  },
  {
    person: "gina-rinehart",
    code: "WCN",
    names: [["hancock-prospecting", "Hancock Prospecting Pty Ltd"]],
  },
  {
    person: "gina-rinehart",
    code: "BM1",
    names: [["hancock-prospecting", "Hancock Prospecting Pty Ltd"]],
  },
  {
    person: "mike-cannon-brookes",
    code: "AGL",
    names: [["galipea", "Galipea Partnership"]],
  },
  {
    person: "richard-white",
    code: "WTC",
    names: [["realwise-holdings", "RealWise Holdings Pty Ltd"]],
  },
  {
    person: "brett-blundy",
    code: "LOV",
    names: [
      ["bb-retail-capital", "BB Retail Capital Pty Ltd"],
      ["bbfit-investments", "BBFit Investments Pte Ltd"],
    ],
  },
  {
    person: "graham-turner",
    code: "FLT",
    names: [["gainsdale", "Gainsdale Pty Ltd"]],
  },
];
function index(
  map: Map<string, GraphNode>,
  kind: GraphKind,
  id: string,
  name: string,
) {
  const found = map.get(id);
  if (found) return found;
  const node = { kind, id, name };
  map.set(id, node);
  return node;
}

const vehiclesByPerson = new Map(
  vehicleSources.map((row) => [
    row.code + "/" + row.person,
    row.names.map(([id, name]) => index(vehicles, "organisation", id, name)),
  ]),
);
// Join a ranked parcel only to the legal holder printed on that row. The
// issuer's separate group-interest disclosure may expressly name several.
function parcelVehicles(code: string, person: string, filedName: string) {
  const legalName = (s: string) =>
    filedNameKey(s)
      .replace(/\blimited\b/g, "ltd")
      .split("<")[0]!
      .trim();
  return (vehiclesByPerson.get(code + "/" + person) ?? []).filter(
    (v) => legalName(filedName) === legalName(v.name),
  );
}
export function scopedAccount(code: string, name: string): GraphNode {
  // Exact filed names are scoped to an issuer. Keep account qualifiers, even
  // articles such as THE, and never merge using the human-readable URL prefix.
  const key = filedNameKey(name);
  const label = key
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 46)
    .replace(/-$/, "");
  const digest = createHash("sha256")
    .update(code + "/" + key)
    .digest("hex")
    .slice(0, 12);
  return {
    kind: "account",
    id: code.toLowerCase() + "-" + label + "-" + digest,
    name,
  };
}

export function issuerOfAccount(id: string) {
  return /^([a-z0-9]{1,6})-[a-z0-9-]{0,46}-[a-f0-9]{12}$/
    .exec(id)?.[1]
    ?.toUpperCase();
}

function accountFor(code: string, name: string) {
  const node = scopedAccount(code, name);
  return index(accounts, node.kind, node.id, node.name);
}

for (const row of RANKED_HOLDERS)
  index(companies, "company", row.code, row.company);
for (const person of AUSTRALIAN_INVESTORS) {
  index(people, "person", person.slug, person.name);
  for (const f of person.filings) {
    const company = f.notice?.company ?? f.annualInterest?.company;
    if (company) index(companies, "company", f.code, company);
  }
}
export const graphRecords: GraphRecord[] = AUSTRALIAN_INVESTORS.flatMap(
  (person) => {
    const investor = people.get(person.slug)!;
    const records: GraphRecord[] = [];
    for (const row of RANKED_HOLDERS.filter((r) => r.profile === person.slug)) {
      const identity =
        person.filings.find((f) => f.code === row.code && f.sourceLabel) ??
        person.filings.find((f) => f.code === row.code);
      records.push({
        person: investor,
        company: companies.get(row.code)!,
        account: accountFor(row.code, row.name),
        vehicles: parcelVehicles(row.code, person.slug, row.name),
        source: row.source,
        identitySource: identity?.source ?? row.source,
        document: "Annual register · p. " + row.page,
        date: row.date,
        yearEnd: row.dateBasis === "financial-year-end",
        rank: row.rank,
        value: investorPct(row.pct),
        unit: "of issued shares",
        shares: row.shares,
      });
    }
    for (const f of person.filings) {
      if (
        f.basis === "annual" &&
        !f.annualInterest &&
        records.some((r) => r.company.id === f.code)
      )
        continue;
      const annual = f.annualInterest,
        notice = f.notice;
      const pct = annual?.amount.pct ?? notice?.pct;
      const ceased = notice?.form === "605";
      records.push({
        person: investor,
        company: index(companies, "company", f.code, names[f.code] ?? f.code),
        account: accountFor(f.code, f.filedName),
        vehicles: vehiclesByPerson.get(f.code + "/" + person.slug) ?? [],
        source: f.source,
        identitySource: f.source,
        date: annual?.date ?? notice?.date,
        document: annual
          ? "Annual report · p. " + annual.page
          : notice
            ? "Form " + notice.form
            : "ASX filing",
        value: pct != null ? investorPct(pct) : undefined,
        unit: ceased
          ? "Ceased to be substantial"
          : annual
            ? "Reported interest"
            : notice
              ? "voting power"
              : "Named in filing",
        shares: annual?.amount.shares,
      });
    }
    return records;
  },
);
/** Match a live notice to a filed identity only within the same issuer. */
export function graphFilerNode(
  code: string,
  name: string,
): GraphNode | undefined {
  const key = filedNameKey(name);
  const rows = graphRecords.filter((r) => r.company.id === code);
  for (const r of rows)
    if (filedNameKey(r.account.name) === key) return r.account;
  return rows
    .flatMap((r) => r.vehicles)
    .find((v) => filedNameKey(v.name) === key);
}
export function graphRows(node: GraphNode) {
  return graphRecords
    .filter((r) =>
      node.kind === "company"
        ? r.company.id === node.id
        : node.kind === "person"
          ? r.person.id === node.id
          : node.kind === "account"
            ? r.account.id === node.id
            : r.vehicles.some((v) => v.id === node.id),
    )
    .sort(
      (a, b) =>
        a.company.id.localeCompare(b.company.id) ||
        (b.date ?? "").localeCompare(a.date ?? "") ||
        (a.rank ?? Infinity) - (b.rank ?? Infinity) ||
        a.person.name.localeCompare(b.person.name),
    );
}
export function localGraphNode(
  kind: string,
  id: string,
): GraphNode | undefined {
  if (kind === "company") return companies.get(id.toUpperCase());
  if (kind === "person") return people.get(id);
  if (kind === "account") return accounts.get(id);
  if (kind === "organisation") return vehicles.get(id);
  return undefined;
}
export const graphNodeLabel: Record<GraphKind, string> = {
  company: "ASX company",
  person: "Investor profile",
  account: "Filed account or interest",
  organisation: "Named organisation",
  institution: "Institution",
};
export function graphRole(person: GraphNode, code: string) {
  const p = investorBySlug(person.id);
  if (!p) return undefined;
  const role = professionalRecord(p);
  const company = companies.get(code);
  if (
    role &&
    company &&
    role.organization.toLowerCase() === company.name.toLowerCase()
  )
    return role;
  if (person.id === "kgn-goran-stefkovski" && code === "KGN")
    return {
      role: "Chief technology officer",
      source:
        "https://app.factor-insights.com/events/cto-day-sydney#:~:text=Goran%20Stefkovski",
      sourceLabel: "CTO Day biography",
    };
  return undefined;
}
export const graphSearchItems = [
  ...companies.values(),
  ...people.values(),
  ...vehicles.values(),
  ...accounts.values(),
  ...TRADERS.filter((t) => t.reporting.market === "ASX").map((t) => ({
    kind: "person" as const,
    id: t.slug,
    name: t.name,
  })),
  ...TRADERS.flatMap((t) =>
    t.reporting.market === "ASX"
      ? [{ kind: "institution" as const, id: t.reporting.holder, name: t.firm }]
      : [],
  ),
].map((n) => ({
  name: n.name,
  detail: n.kind === "company" ? "ASX · " + n.id : graphNodeLabel[n.kind],
  href: graphHref(n.kind, n.id),
}));
