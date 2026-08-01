"use server";

/**
 * The /politicians/changes activity explorer's data path.
 *
 * WHY A SEPARATE `"use server"` MODULE. `getPoliticians.ts` is a plain server
 * module — its exports are `cache(withRetryAndNotFound(...))` wrappers, not bare
 * async functions, so it cannot carry the directive. This file is the thin
 * action layer the client island is handed as a prop, and it is the ONLY place
 * the protobuf messages become plain JSON.
 *
 * WHY THE MAPPING HAPPENS HERE. Register messages carry `google.protobuf.
 * Timestamp`s, which are BigInt-backed and make `JSON.stringify` throw, and the
 * generated types carry a `$typeName` with no business crossing the RSC
 * boundary. The island therefore never sees a proto — only the plain row shapes
 * it declares.
 *
 * The same function serves the server page's first render and the island's
 * re-queries, so the two can never drift into rendering different shapes.
 *
 * TWO RPCS, ONE PAGE, AND THE ORDER MATTERS. `GetRegisterActivity` is called
 * FIRST because it is the authority on the window: the backend rounds a request
 * UP to the next window it serves (45 -> 90) and echoes back the one it used, so
 * the feed's `since` is derived from the ECHOED window rather than the requested
 * one. Deriving it from the request would put a 45-day feed under a 90-day
 * strip and caption both with the same number.
 */

import {
  clampRegisterActivityWindow,
  clampRegisterChangeFeedQuery,
  getRegisterActivity,
  listRegisterChangeFeed,
  registerWindowStart,
  type RegisterChangeKindKey,
} from "./getPoliticians";
import { toDate } from "@/lib/politics/timestamp";
import { RegisterChangeKind, RegisterHolder } from "~/gen/shorts/v1alpha1/politicians_pb";
import type {
  ActivityEventRow,
  RegisterActivityPage,
  RegisterActivityQuery,
} from "@/components/politicians/register-activity-explorer";

/**
 * Holder copy, IDENTICAL to the compliance kit's `HOLDER_COPY` labels, which a
 * test locks.
 *
 * Duplicated rather than imported because compliance.tsx is a component module
 * and this is a data path — but the STRINGS are the register's own attribute and
 * must not diverge. "Holder not stated" is a real answer, not a fallback: 2,279
 * published rows come from forms with no holder column, and inferring one would
 * attribute a spouse's interest to the member.
 */
const HOLDER_LABEL: Record<number, string> = {
  [RegisterHolder.SELF]: "Self",
  [RegisterHolder.SPOUSE_PARTNER]: "Spouse/partner",
  [RegisterHolder.DEPENDENT_CHILDREN]: "Dependent child",
  [RegisterHolder.UNSPECIFIED]: "Holder not stated",
};

/**
 * What kind of thing a declaration names, for the kinds that can never carry a
 * ticker. Same vocabulary as the compliance kit's `ENTITY_KIND_COPY`, and the
 * same omissions: `listed` and `not_an_entity` carry no badge.
 */
const ENTITY_KIND_LABEL: Record<string, string> = {
  private_company: "Private company",
  family_trust: "Family trust",
  smsf: "Self-managed super fund",
  managed_fund: "Managed fund",
  foreign: "Foreign listing",
};

/** `3 Jul 2026`. Formatted server-side so hydration cannot change it. */
function dayLabel(date: Date | undefined): string {
  if (!date) return "";
  return date.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** `YYYY-MM-DD` -> `3 Jul 2026`, or "" when the string is not a date. */
function isoDayLabel(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? "" : dayLabel(date);
}

function isoDay(date: Date | undefined): string {
  return date ? date.toISOString().slice(0, 10) : "";
}

/**
 * Normalise a partial query into the one the server will actually run.
 *
 * Exported for the server page, which asks for the default view without
 * importing a default constant out of the `"use client"` island — a server
 * component that reads a plain value from a client module gets a
 * client-reference proxy and throws on the first property access, at prerender
 * time, where neither jest nor tsc can see it.
 */
export async function clampRegisterActivityQuery(
  input: Partial<RegisterActivityQuery> = {},
): Promise<RegisterActivityQuery> {
  const feed = clampRegisterChangeFeedQuery({
    kind: input.kind as RegisterChangeKindKey | undefined,
    politicianSlug: input.politicianSlug,
    itemNo: input.itemNo,
    partyAb: input.partyAb,
    chamber: input.chamber,
    limit: input.limit,
    offset: input.offset,
  });
  return {
    windowDays: clampRegisterActivityWindow(input.windowDays ?? 90),
    kind: feed.kind,
    chamber: feed.chamber,
    partyAb: feed.partyAb,
    itemNo: feed.itemNo,
    politicianSlug: feed.politicianSlug,
    limit: feed.limit,
    offset: feed.offset,
  };
}

/**
 * One view of the activity explorer: the strip, the count line, the feed and the
 * rails.
 *
 * NEVER THROWS. It is awaited by the static page's own render, so a failed fetch
 * must degrade to an empty view rather than take the route down.
 *
 * WHICH IS WHY IT REPORTS `ok` AND `railsOk` SEPARATELY. A failed fetch and a
 * filter nobody matches both arrive as zero rows and mean opposite things: one
 * is our outage, the other is an honest answer about the filter. Collapsing them
 * lets the island word an outage as "no register events match" — a false absence
 * claim about every member the filter covers, published on our own downtime. The
 * two flags are separate because the two rpcs fail independently: a dead rails
 * query must not blank a healthy feed.
 */
export async function loadRegisterActivity(
  input: Partial<RegisterActivityQuery> = {},
): Promise<RegisterActivityPage> {
  const query = await clampRegisterActivityQuery(input);

  // The rails first: their response is the authority on the window (see the
  // file docblock). A failure here leaves the feed to run on the clamp we
  // already applied, which agrees with the backend's by construction.
  const activity = await getRegisterActivity(query.windowDays).catch(() => undefined);
  const windowDays = activity?.windowDays
    ? clampRegisterActivityWindow(activity.windowDays)
    : query.windowDays;

  const feed = await listRegisterChangeFeed(
    clampRegisterChangeFeedQuery({
      since: registerWindowStart(windowDays),
      kind: query.kind,
      politicianSlug: query.politicianSlug,
      itemNo: query.itemNo,
      partyAb: query.partyAb,
      chamber: query.chamber,
      limit: query.limit,
      offset: query.offset,
    }),
  ).catch(() => undefined);

  const events: ActivityEventRow[] = (feed?.events ?? [])
    .map((event, index): ActivityEventRow | null => {
      const politician = event.politician;
      // An event with no politician cannot be attributed to anyone, so it is
      // dropped rather than rendered against a blank name.
      if (!politician?.slug) return null;
      const changedOn = toDate(event.changedOn);
      return {
        id: `${politician.slug}-${index}`,
        changedOn: isoDay(changedOn),
        dateLabel: dayLabel(changedOn),
        // UNSPECIFIED cannot reach here — the store only emits added/removed —
        // and if it ever did, "removed" is the reading that claims least.
        kind: event.kind === RegisterChangeKind.ADDED ? "added" : "removed",
        slug: politician.slug,
        displayName: politician.displayName,
        partyAb: politician.partyAb ?? "",
        itemNo: Number(event.itemNo ?? 0),
        itemLabel: event.itemLabel ?? "",
        holderLabel: HOLDER_LABEL[event.holder] ?? HOLDER_LABEL[RegisterHolder.UNSPECIFIED] ?? "",
        declaredText: event.declaredText ?? "",
        stockCode: event.stockCode ?? "",
        companyName: event.companyName ?? "",
        entityKindLabel: ENTITY_KIND_LABEL[event.entityKind ?? ""] ?? "",
      };
    })
    .filter((row): row is ActivityEventRow => row !== null);

  return {
    query: { ...query, windowDays },
    windowDays,
    events,
    total: Number(feed?.total ?? 0),
    weeks: (activity?.weeks ?? []).map((week) => ({
      weekStart: week.weekStart,
      addedCount: Number(week.addedCount ?? 0),
      removedCount: Number(week.removedCount ?? 0),
    })),
    activeMembers: (activity?.activeMembers ?? [])
      .filter((member) => !!member.slug)
      .map((member) => ({
        slug: member.slug,
        displayName: member.displayName,
        partyAb: member.partyAb ?? "",
        eventCount: Number(member.eventCount ?? 0),
      })),
    newlyDeclaredCompanies: (activity?.newlyDeclaredCompanies ?? [])
      .filter((company) => !!company.stockCode)
      .map((company) => ({
        stockCode: company.stockCode,
        companyName: company.companyName ?? "",
        firstDeclaredOn: company.firstDeclaredOn ?? "",
        firstDeclaredLabel: isoDayLabel(company.firstDeclaredOn ?? ""),
        declarerCount: Number(company.declarerCount ?? 0),
      })),
    declarerCountChanges: (activity?.declarerCountChanges ?? [])
      .filter((company) => !!company.stockCode)
      .map((company) => ({
        stockCode: company.stockCode,
        companyName: company.companyName ?? "",
        declarersNow: Number(company.declarersNow ?? 0),
        declarersAtWindowStart: Number(company.declarersAtWindowStart ?? 0),
      })),
    undatedCurrentCount: Number(activity?.undatedCurrentCount ?? 0),
    // `undefined` is the retry helper's exhausted/not-found signal: the request
    // did not answer. A genuinely empty filtered result comes back as a RESPONSE
    // carrying no events and reaches `ok: true` with zero rows — which is what
    // lets the island tell the two apart.
    ok: feed !== undefined,
    railsOk: activity !== undefined,
  };
}

/** The register's own as-at, for the page footer's citation. */
export async function getRegisterActivityAsAt(windowDays = 90): Promise<Date | undefined> {
  const activity = await getRegisterActivity(clampRegisterActivityWindow(windowDays)).catch(
    () => undefined,
  );
  return toDate(activity?.asAt);
}
