import {
  filedNameKey,
  investorBySlug,
  investorCodes,
} from "./australian-investors";
import type { DisclosureRow } from "./investor-disclosures";
import { filerId } from "./named-filer";

export type SavedInvestor = {
  id: string;
  name: string;
  code?: string;
  source?: string;
};
export type InvestorRegister = {
  code: string;
  asOf: string | null;
  limited: boolean;
  notices: DisclosureRow[];
};

export const REGISTER_BATCH = 6;
export const PAGE_SIZE = 25;
export const filingEvents = [
  "became",
  "increased",
  "decreased",
  "changed",
  "ceased",
] as const;
export type FilingEvent = (typeof filingEvents)[number];
export type FilingOrder = "latest" | "power" | "move";

export function matchesWords(text: string, query: string) {
  const words = filedNameKey(query).split(" ");
  const candidate = filedNameKey(text);
  return words.every((word) => candidate.includes(word));
}

export function pointChange(row: DisclosureRow) {
  if (
    row.ceased ||
    row.form === "603" ||
    row.event === "became" ||
    row.previous === null ||
    row.pct === null
  )
    return null;
  // Notices carry four decimal places. Round at their precision before sorting ties.
  return Math.round((row.pct - row.previous) * 10000) / 10000;
}

export function filingId(row: DisclosureRow) {
  return JSON.stringify([
    row.code,
    filedNameKey(row.name),
    row.date,
    row.announcement ??
      row.source ?? [row.form, row.effective, row.event, row.previous, row.pct],
  ]);
}

export function watchCodes(followed: readonly SavedInvestor[]) {
  const codes = new Set<string>();
  for (const item of followed) {
    if (item.code) codes.add(item.code);
    else {
      const person = investorBySlug(item.id);
      if (person) for (const code of investorCodes(person)) codes.add(code);
    }
  }
  return [...codes].sort();
}

export function followedFilings(
  registers: readonly InvestorRegister[],
  followed: readonly SavedInvestor[],
) {
  const ids = new Set(followed.map((f) => f.id));
  const matched = new Map<string, DisclosureRow>();
  for (const register of registers) {
    for (const row of register.notices) {
      if (row.code !== register.code) continue;
      if (
        (row.profile !== null && ids.has(row.profile)) ||
        ids.has(filerId(row.code, row.name))
      ) {
        matched.set(filingId(row), row);
      }
    }
  }
  return [...matched.values()];
}

export function selectFilings(
  rows: readonly DisclosureRow[],
  options: {
    query: string;
    event: string;
    order: FilingOrder;
    titled?: boolean;
  },
) {
  const selected = rows.filter((row) => {
    if (options.event && (row.ceased ? "ceased" : row.event) !== options.event)
      return false;
    if (options.titled && !/^(?:mr|mrs|ms|miss|dr)\.?\s/i.test(row.name.trim()))
      return false;
    const displayName = row.profile
      ? (investorBySlug(row.profile)?.name ?? "")
      : "";
    return matchesWords(
      `${row.name} ${row.code} ${row.company} ${displayName}`,
      options.query,
    );
  });
  if (options.order === "move") {
    // Initial and ceasing notices cannot supply a comparable percentage-point change.
    return selected
      .filter((r) => pointChange(r) !== null)
      .sort(
        (a, b) =>
          Math.abs(pointChange(b)!) - Math.abs(pointChange(a)!) ||
          newestFirst(a, b),
      );
  }
  return selected.sort(
    (a, b) =>
      (options.order === "power" ? (b.pct ?? -1) - (a.pct ?? -1) : 0) ||
      newestFirst(a, b),
  );
}

function newestFirst(a: DisclosureRow, b: DisclosureRow) {
  return (
    b.date.localeCompare(a.date) ||
    b.code.localeCompare(a.code) ||
    (b.source ?? "").localeCompare(a.source ?? "") ||
    a.name.localeCompare(b.name)
  );
}
