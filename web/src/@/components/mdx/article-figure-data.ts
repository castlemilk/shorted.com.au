/** Declarative figure data shared by the HTML and plain-text article renderers. */
export type FigureData<T> = readonly T[] | string;
type RecordValue = Record<string, unknown>;

export function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function text(value: unknown): value is string {
  return typeof value === "string";
}

export function number(value: number | string): number {
  return typeof value === "number" ? value : Number(value.replace(/[$,%\s]/g, ""));
}

export function numeric(value: unknown): value is number | string {
  return (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.replace(/[$,%\s]/g, "") !== "" && Number.isFinite(number(value)));
}

/** Parse data, never executable source. Invalid author data fails visibly. */
export function entries<T>(value: FigureData<T> | undefined, valid: (entry: unknown) => entry is T, prop: string): readonly T[] {
  if (value === undefined) return [];
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`Article figure ${prop} must be a valid JSON array.`);
    }
  }
  if (!Array.isArray(parsed) || !parsed.every(valid)) {
    throw new Error(`Article figure ${prop} contains invalid data.`);
  }
  return parsed;
}

export interface StatItem {
  value: string | number;
  label: string;
  hint?: string;
  accent?: boolean;
}

export interface RankItem {
  label: string;
  value: number | string;
  display?: string;
  accent?: boolean;
}

export function parseStatItems(items: FigureData<StatItem> | undefined): readonly StatItem[] {
  return entries(items, (value): value is StatItem => record(value) &&
    (text(value.value) || (typeof value.value === "number" && Number.isFinite(value.value))) && text(value.label) &&
    (value.hint === undefined || text(value.hint)) && (value.accent === undefined || typeof value.accent === "boolean"), "items");
}

export function parseRankItems(items: FigureData<RankItem> | undefined): readonly RankItem[] {
  return entries(items, (value): value is RankItem => record(value) && text(value.label) && numeric(value.value) &&
    (value.display === undefined || text(value.display)) && (value.accent === undefined || typeof value.accent === "boolean"), "items");
}
