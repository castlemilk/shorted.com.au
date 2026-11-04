/**
 * The workspace selection (spec 14.1): what the inspector shows and what the
 * instruments highlight, carried in the URL as `?sel=<kind>:<key>`.
 *
 *   stock:PLS                      a company
 *   holder:vanguard                a holder (a registry slug, or a name:/asx: key)
 *   connection:index_manager>Materials   a holder kind to a sector
 *   cell:Materials@2026-10-26      a sector in one week of the activity grid, every holder type
 *   cell:Materials@2026-10-26:index_manager   the same cell for one holder kind
 *   fund:asx:A200                  an index fund or super option, by the API's fund_key
 *   fund:aware/High Growth         a super option: <institution_slug>/<fund name>
 *   holding:asx:A200/BHP           one holding of one fund (the code after the LAST slash)
 *
 * The sector kind is INTERNAL (backlog C4): the map's zoom lives in `?sector=`,
 * and the inspector shows that sector when no `sel` is set. It is built in code
 * (`sectorSelection`) and never parsed from a link, so `sel=sector:...` is no
 * selection and a shared link cannot pick a sector through `sel`.
 *
 * READ AND WRITE ARE ONE RULE, as in desk-state.ts: `parseSelection` accepts a
 * string only when `serializeSelection` of what it parses is that same string,
 * so a link round-trips by construction and an unknown or malformed value reads
 * as no selection at all (never a partial one).
 *
 * A PURE MODULE. No React, no DOM, no Connect: the islands, the desk state and
 * the server pages read it alike.
 */

export const SELECTION_KINDS = [
  "stock",
  "holder",
  "connection",
  "cell",
  "fund",
  "holding",
] as const;
export type SelectionKind = (typeof SELECTION_KINDS)[number];

export type Selection =
  | { kind: "stock"; code: string }
  | { kind: "holder"; key: string }
  | { kind: "connection"; holderKind: string; sector: string }
  | { kind: "cell"; sector: string; date: string; holderKind?: string }
  | { kind: "fund"; fundKey: string }
  | { kind: "holding"; fundKey: string; code: string }
  /** Internal only (C4): the zoomed sector, read from `?sector=`. Never parsed from `sel`. */
  | { kind: "sector"; sector: string };

/** A selection a link can carry: every kind but the internal sector, which a link never names. */
export type LinkSelection = Exclude<Selection, { kind: "sector" }>;

/**
 * A selection link is short (spec 14.7); anything longer is not one this codec wrote. The cap
 * fits the longest holding a fund key can make: "holding:" (8) + an institution slug (64) +
 * "/" + a fund name (200, FUND_NAME_MAX) + "/" + a stock code (6), so 280 (spec 14.8).
 */
const SELECTION_MAX = 280;
const SECTOR_MAX = 64;
const HOLDER_MAX = 120;
const CODE = /^[A-Z0-9]{1,6}$/;
const HOLDER_KIND = /^[a-z_]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The registry keys the API takes whole (ownership_funds.go registryFundKey). */
const REGISTRY_FUND_KEY = /^(abn:[0-9]{11}|asx:[A-Z0-9]{2,10})$/;
/** An institution slug (ownership_funds.go institutionSlugRe). */
const INSTITUTION_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A super option's fund name is at most this many characters (ownership_funds.go fundNameMax). */
const FUND_NAME_MAX = 200;
/** Any control character: a key is printed and carried in a link, never a line break. */
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Control characters as the API's unicode.IsControl reads them, C0 and C1. */
const FUND_NAME_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** A calendar date in YYYY-MM-DD form. Local, because desk-state.ts imports this module. */
function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function cleanSector(value: string): string | null {
  if (value.length === 0 || value.length > SECTOR_MAX) return null;
  if (value !== value.trim() || CONTROL.test(value)) return null;
  return value;
}

/**
 * A fund key as the API takes it (parseFundKey in ownership_funds.go), in the
 * canonical form the codec writes: a registry key (`asx:<CODE>`, `abn:<11
 * digits>`), or `<institution_slug>/<fund name>` where the name may hold spaces
 * and further slashes but no control character, and no space at either end.
 */
export function isFundKey(key: string): boolean {
  if (REGISTRY_FUND_KEY.test(key)) return true;
  const slash = key.indexOf("/");
  if (slash <= 0) return false;
  const slug = key.slice(0, slash);
  const name = key.slice(slash + 1);
  return INSTITUTION_SLUG.test(slug) && isFundName(name);
}

function isFundName(name: string): boolean {
  if (name.length === 0 || name !== name.trim()) return false;
  if ([...name].length > FUND_NAME_MAX || FUND_NAME_CONTROL.test(name)) return false;
  return true;
}

function cleanHolderKey(value: string): string | null {
  if (value.length === 0 || value.length > HOLDER_MAX) return null;
  if (value !== value.trim() || CONTROL.test(value)) return null;
  return value;
}

/**
 * A selection from its link form, or null for anything the codec would not
 * write. The kind is everything before the first colon; the key is the rest.
 */
export function parseSelection(raw: string): LinkSelection | null {
  // `sector` is not a link kind: the zoom is `?sector=`, so `default` refuses it like any unknown kind.
  if (raw.length === 0 || raw.length > SELECTION_MAX) return null;
  const colon = raw.indexOf(":");
  if (colon <= 0) return null;
  const kind = raw.slice(0, colon);
  const key = raw.slice(colon + 1);
  if (key.length === 0) return null;

  switch (kind) {
    case "stock":
      return CODE.test(key) ? { kind, code: key } : null;
    case "holder": {
      const clean = cleanHolderKey(key);
      return clean === null ? null : { kind, key: clean };
    }
    case "connection": {
      const arrow = key.indexOf(">");
      if (arrow <= 0) return null;
      const holderKind = key.slice(0, arrow);
      const sector = cleanSector(key.slice(arrow + 1));
      if (!HOLDER_KIND.test(holderKind) || sector === null) return null;
      return { kind, holderKind, sector };
    }
    case "cell": {
      // The holder kind follows the date after a colon; "all" is no colon at all, so `cell:S@D:` is refused.
      // No holder kind holds an "@", so the last one is the separator.
      const at = key.lastIndexOf("@");
      if (at <= 0) return null;
      const sector = cleanSector(key.slice(0, at));
      const rest = key.slice(at + 1);
      const colon = rest.indexOf(":");
      const date = colon < 0 ? rest : rest.slice(0, colon);
      if (sector === null || !isIsoDate(date)) return null;
      if (colon < 0) return { kind, sector, date };
      const holderKind = rest.slice(colon + 1);
      if (!HOLDER_KIND.test(holderKind)) return null;
      return { kind, sector, date, holderKind };
    }
    case "fund":
      return isFundKey(key) ? { kind, fundKey: key } : null;
    case "holding": {
      // The fund key may hold slashes (a super option's name), a stock code never does: split on the last.
      const slash = key.lastIndexOf("/");
      if (slash <= 0) return null;
      const fundKey = key.slice(0, slash);
      const code = key.slice(slash + 1);
      if (!isFundKey(fundKey) || !CODE.test(code)) return null;
      return { kind, fundKey, code };
    }
    default:
      return null;
  }
}

/** The link form of a selection. `parseSelection` reads back exactly this. */
export function serializeSelection(selection: Selection): string {
  switch (selection.kind) {
    case "stock":
      return `stock:${selection.code}`;
    case "holder":
      return `holder:${selection.key}`;
    case "connection":
      return `connection:${selection.holderKind}>${selection.sector}`;
    case "cell":
      return `cell:${selection.sector}@${selection.date}${selection.holderKind ? `:${selection.holderKind}` : ""}`;
    case "fund":
      return `fund:${selection.fundKey}`;
    case "holding":
      return `holding:${selection.fundKey}/${selection.code}`;
    case "sector":
      return `sector:${selection.sector}`;
  }
}

/**
 * The internal sector selection for a zoomed sector (backlog C4), or null for a value that is not a
 * sector name the codec would print. It is not `parseSelection`: a sector never comes from a link.
 */
export function sectorSelection(sector: unknown): Selection | null {
  if (typeof sector !== "string") return null;
  const clean = cleanSector(sector);
  return clean === null ? null : { kind: "sector", sector: clean };
}

/** The link value a raw string cleans to: its canonical form, or "" for no selection. */
export function cleanSelection(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const parsed = parseSelection(raw);
  return parsed === null ? "" : serializeSelection(parsed);
}

/** The heading the inspector names the kind of thing with (spec 14.1), in small caps. */
export function selectionHeading(selection: Selection): string {
  switch (selection.kind) {
    case "stock":
      return "Selected company";
    case "holder":
      return "Selected holder";
    case "connection":
      return "Selected connection";
    case "cell":
      return "Selected";
    case "fund":
      return "Selected fund";
    case "holding":
      return "Selected holding";
    case "sector":
      return "Selected sector";
  }
}

/** Whether a selection names this company: directly, or through a holding of it. */
export function selectionNamesStock(selection: Selection | null, code: string): boolean {
  if (selection === null) return false;
  if (selection.kind === "stock") return selection.code === code;
  if (selection.kind === "holding") return selection.code === code;
  return false;
}

/**
 * A query string with the selection removed and every other parameter kept, in
 * order, for the inspector's "Clear selection" link. "" when nothing else is set.
 */
export function withoutSelection(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("sel");
  return params.toString();
}
