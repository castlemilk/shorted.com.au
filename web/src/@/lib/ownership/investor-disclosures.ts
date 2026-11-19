import type {
  GetStockOwnershipResponse,
  ListSubstantialNoticesResponse,
  SubstantialNotice,
} from "~/gen/shorts/v1alpha1/ownership_pb";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import {
  filedNameKey,
  filingNames,
  investorForFiling,
  type FilingIdentity,
} from "./australian-investors";

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
>;

export function disclosureRow(n: Notice) {
  const ceased = n.form === "605" || n.event === "ceased";
  return {
    code: n.stockCode,
    company: n.companyName,
    name: n.holderName,
    form: n.form,
    date: n.announcedOn,
    effective: n.eventDate,
    event: n.event,
    ceased,
    pct: !ceased && n.hasPresent ? n.presentPct : null,
    previous: n.hasPrevious ? n.previousPct : null,
    source: safeExternalHref(n.announcementUrl) ?? null,
    profile: investorForFiling(n.stockCode, n.holderName)?.slug ?? null,
  };
}
export type DisclosureRow = ReturnType<typeof disclosureRow>;

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
  const interest = data?.holders?.find(matches);
  const history = data?.history ?? [];
  return {
    filing,
    company: data?.summary?.companyName ?? "",
    asOf: data?.asOf ?? "",
    current: interest
      ? {
          pct: interest.votingPowerPct,
          date: interest.announcedOn,
          name: interest.holderName,
          source: safeExternalHref(interest.announcementUrl),
        }
      : null,
    history: history.filter(matches).map(disclosureRow),
    historyLimited: (data?.historyTotal ?? 0) > history.length,
  };
}
