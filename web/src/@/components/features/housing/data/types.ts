/**
 * Shared types for "The Widow-Maker" housing feature data layer.
 *
 * Every numeric series carries a `sourceId` linking to the bibliography in
 * `sources.ts`. Estimated / derived / anchor values are flagged explicitly so
 * captions can disclose them — the feature only ships verified figures.
 */

export type SourceGroup =
  | "short-thesis"
  | "negative-gearing"
  | "cgt"
  | "bank-credit"
  | "international";

export interface Source {
  /** Stable id referenced by <Cite id="…" /> and `#source-<id>` anchors. */
  id: string;
  /** Display number (assigned in reading order). */
  n: number;
  title: string;
  publisher: string;
  year: string;
  url: string;
  group: SourceGroup;
}

export interface YearValue {
  year: number;
  value: number;
}

/** A labelled event drawn as a vertical marker on a time-series chart. */
export interface MarkerEvent {
  year: number;
  label: string;
  detail?: string;
  sourceId?: string;
}

/** A real house-price index for one country, indexed 2010 = 100 (BIS). */
export interface CountrySeries {
  code: "AUS" | "JPN" | "USA" | "CHN";
  name: string;
  color: string;
  /** Bubble peak year used to align the "years-from-peak" overlay. */
  peakYear: number;
  /** Real HPI, BIS 2010 = 100, annual average. */
  data: YearValue[];
  /** One-line crash summary for the legend / annotation. */
  crashNote: string;
}

/** A headline figure rendered in a stat strip, with its citation. */
export interface FeatureStat {
  value: string;
  label: string;
  context?: string;
  sourceId?: string;
  /** Optional tone: positive (green), negative (red), or neutral (amber). */
  tone?: "up" | "down" | "neutral";
}
