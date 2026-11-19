import type {
  GetStockOwnershipResponse,
  ListSubstantialNoticesResponse,
  SubstantialNotice,
} from "~/gen/shorts/v1alpha1/ownership_pb";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import {
  announcementUrl,
  filedNameKey,
  filingNames,
  investorForFiling,
  type FilingIdentity,
} from "./australian-investors";

import reviewedVotes from "./reviewed-filing-votes.json";

type FilingKey = Pick<
  SubstantialNotice,
  "stockCode" | "holderName" | "form" | "announcementUrl"
>;
const reviewedByUrl = new Map(
  reviewedVotes.flatMap((r) =>
    [r.announcement, r.source].map((url) => [url, r] as const),
  ),
);

// During a rolling deployment ISR may read an older API or cached register.
// Only the exact issuer, named filer, form and reviewed PDF can use these figures.
function reviewedFor(n: FilingKey) {
  const r = reviewedByUrl.get(n.announcementUrl);
  return r &&
    r.code === n.stockCode &&
    r.form === n.form &&
    filedNameKey(r.name) === filedNameKey(n.holderName)
    ? r
    : undefined;
}

function verifiedFiling(n: FilingKey) {
  const person = investorForFiling(n.stockCode, n.holderName);
  return person?.filings.find((f) => {
    const notice = f.notice;
    return (
      f.code === n.stockCode &&
      notice !== undefined &&
      notice.form === n.form &&
      (n.announcementUrl === f.source ||
        n.announcementUrl === announcementUrl(notice.announcementId))
    );
  });
}

export function currentFilerRow(
  h: GetStockOwnershipResponse["holders"][number],
) {
  const r = reviewedFor(h);
  return {
    name: h.holderName,
    form: h.form,
    pct: r?.pct ?? h.votingPowerPct,
    date: h.announcedOn,
    votes: r
      ? r.votes.toLocaleString("en-AU")
      : h.hasVotes
        ? h.votes.toLocaleString("en-AU")
        : undefined,
    source:
      r?.source ??
      verifiedFiling(h)?.source ??
      safeExternalHref(h.announcementUrl),
  };
}

type Notice = Pick<
  SubstantialNotice,
  | "stockCode"
  | "companyName"
  | "holderName"
  | "form"
  | "presentPct"
  | "hasPresent"
  | "previousPct"
  | "hasPrevious"
  | "eventDate"
  | "announcedOn"
  | "announcementUrl"
  | "event"
> &
  Partial<Pick<SubstantialNotice, "ceased">>;

export function disclosureRow(n: Notice) {
  const r = reviewedFor(n);
  const filing = verifiedFiling(n);
  const ceased =
    r?.ceased ??
    (n.form === "605" || n.event === "ceased" || n.ceased === true);
  const event = r
    ? r.pct > r.previousPct
      ? "increased"
      : r.pct < r.previousPct
        ? "decreased"
        : "changed"
    : n.event;
  return {
    code: n.stockCode,
    company: n.companyName,
    name: n.holderName,
    form: n.form,
    date: n.announcedOn,
    effective: n.eventDate,
    event,
    ceased,
    pct: ceased ? null : (r?.pct ?? (n.hasPresent ? n.presentPct : null)),
    previous: r?.previousPct ?? (n.hasPrevious ? n.previousPct : null),
    source:
      r?.source ??
      filing?.source ??
      safeExternalHref(n.announcementUrl) ??
      null,
    ...(filing?.notice && {
      announcement: announcementUrl(filing.notice.announcementId),
    }),
    profile: investorForFiling(n.stockCode, n.holderName)?.slug ?? null,
  };
}
export type DisclosureRow = ReturnType<typeof disclosureRow>;

/** A dated, checked form remains part of the record after it leaves the live window. */
export function archivedDisclosure(
  filing: FilingIdentity,
): DisclosureRow | undefined {
  const notice = filing.notice;
  if (!notice) return;
  return {
    code: filing.code,
    company: notice.company,
    name: filing.filedName,
    form: notice.form,
    date: notice.date,
    effective: "",
    event:
      notice.form === "605"
        ? "ceased"
        : notice.form === "603"
          ? "became"
          : "changed",
    ceased: notice.form === "605",
    pct: notice.pct,
    previous: null,
    source: filing.source,
    announcement: announcementUrl(notice.announcementId),
    profile: investorForFiling(filing.code, filing.filedName)?.slug ?? null,
  };
}

export const DISCOVERY_WINDOW = 90;
export const DISCOVERY_PAGE_SIZE = 100;
const MAX_PAGES = 6;
type NoticePage = Pick<
  ListSubstantialNoticesResponse,
  "asOf" | "total" | "nextCursor"
> & { notices: Notice[] };
export type Discovery = {
  status: "complete" | "partial" | "unavailable";
  asOf: string;
  read: number;
  total: number;
  rows: DisclosureRow[];
};

export async function readDiscovery(
  nextPage: (cursor: string) => Promise<NoticePage | undefined>,
): Promise<Discovery> {
  const latest = new Map<string, DisclosureRow>();
  const seen = new Set<string>();
  const cursors = new Set<string>();
  const result: Discovery = {
    status: "unavailable",
    asOf: "",
    read: 0,
    total: 0,
    rows: [],
  };
  let cursor = "";
  // The service orders descending by release date then filing URL, including
  // across cursor boundaries. Keep the first release for each issuer and name.
  for (let page = 0; page < MAX_PAGES; page++) {
    cursors.add(cursor);
    const response = await nextPage(cursor);
    if (!response || !response.asOf) break;
    if (
      page &&
      (response.asOf !== result.asOf || response.total !== result.total)
    )
      break;
    result.status = "partial";
    result.asOf = response.asOf;
    result.total = response.total;
    for (const n of response.notices) {
      const key = `${n.stockCode}/${filedNameKey(n.holderName)}`;
      const id = `${key}/${n.announcedOn}/${n.announcementUrl}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (
        !latest.has(key) &&
        n.holderName.trim() &&
        ["603", "604", "605"].includes(n.form)
      ) {
        latest.set(key, disclosureRow(n));
      }
    }
    cursor = response.nextCursor;
    if (!cursor) {
      if (seen.size === result.total) result.status = "complete";
      break;
    }
    if (cursors.has(cursor)) break;
  }
  result.read = seen.size;
  result.rows = [...latest.values()];
  return result;
}

export function readFilingIdentity(
  filing: FilingIdentity,
  data?: GetStockOwnershipResponse,
) {
  const names = new Set(filingNames(filing).map(filedNameKey));
  const matches = (r: { stockCode: string; holderName: string }) =>
    r.stockCode === filing.code && names.has(filedNameKey(r.holderName));
  const company = data?.summary?.companyName?.trim();
  const interest = data?.holders
    ?.filter(matches)
    .sort((a, b) => b.announcedOn.localeCompare(a.announcedOn))[0];
  const available = data?.history ?? [];
  const history = available.filter(matches).map(disclosureRow);
  const archived = archivedDisclosure(filing);
  if (archived && !history.some((r) => r.source === archived.source))
    history.push(archived);
  return {
    filing,
    company: company?.length ? company : (filing.notice?.company ?? ""),
    asOf: data?.asOf ?? "",
    current: interest ? currentFilerRow(interest) : null,
    history,
    historyLimited: (data?.historyTotal ?? 0) > available.length,
  };
}
