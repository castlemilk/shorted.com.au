import {
  ScreenerSortField,
  SortDirection,
  type ScreenerFilters,
} from "~/gen/shorts/v1alpha1/shorts_pb";
import { create } from "@bufbuild/protobuf";
import { ScreenerFiltersSchema } from "~/gen/shorts/v1alpha1/shorts_pb";

export interface ScreenerPreset {
  id: string;
  name: string;
  description: string;
  filters: ScreenerFilters;
  sortField: ScreenerSortField;
  sortDirection: SortDirection;
}

export const SCREENER_PRESETS: ScreenerPreset[] = [
  {
    id: "short-squeeze",
    name: "Short Squeeze Candidates",
    description:
      "Heavily shorted stocks where short interest is declining and directors are buying",
    filters: create(ScreenerFiltersSchema, {
      shortPct: { min: 8, hasMin: true, max: 0, hasMax: false },
      shortPctChange: { min: 0, hasMin: false, max: -0.5, hasMax: true },
      hasDirectorBuys: true,
    }),
    sortField: ScreenerSortField.SHORT_PCT,
    sortDirection: SortDirection.DESC,
  },
  {
    id: "dividend-pressure",
    name: "Dividend Aristocrats Under Pressure",
    description:
      "High-yield stocks with rising short interest, signalling potential dividend risk",
    filters: create(ScreenerFiltersSchema, {
      dividendYield: { min: 4, hasMin: true, max: 0, hasMax: false },
      shortPct: { min: 3, hasMin: true, max: 0, hasMax: false },
      shortPctChange: { min: 0.5, hasMin: true, max: 0, hasMax: false },
    }),
    sortField: ScreenerSortField.DIVIDEND_YIELD,
    sortDirection: SortDirection.DESC,
  },
  {
    id: "small-cap-bears",
    name: "Small Cap Bears",
    description:
      "Small-cap stocks with high and rising short interest",
    filters: create(ScreenerFiltersSchema, {
      marketCap: { min: 0, hasMin: false, max: 500000000, hasMax: true },
      shortPct: { min: 5, hasMin: true, max: 0, hasMax: false },
      shortPctChange: { min: 0.5, hasMin: true, max: 0, hasMax: false },
    }),
    sortField: ScreenerSortField.SHORT_PCT,
    sortDirection: SortDirection.DESC,
  },
  {
    id: "director-buying-shorted",
    name: "Director Buying Heavily Shorted",
    description:
      "Heavily shorted stocks where directors are buying with conviction (>$50K net)",
    filters: create(ScreenerFiltersSchema, {
      shortPct: { min: 5, hasMin: true, max: 0, hasMax: false },
      netDirectorBuy: { min: 50000, hasMin: true, max: 0, hasMax: false },
      hasDirectorBuys: true,
    }),
    sortField: ScreenerSortField.NET_DIRECTOR_BUY,
    sortDirection: SortDirection.DESC,
  },
  {
    id: "hard-to-cover",
    name: "Hard to Cover (High DTC)",
    description:
      "Stocks with high days-to-cover (>5 days) — short sellers would struggle to exit quickly",
    filters: create(ScreenerFiltersSchema, {
      daysToCover: { min: 5, hasMin: true, max: 0, hasMax: false },
      shortPct: { min: 3, hasMin: true, max: 0, hasMax: false },
    }),
    sortField: ScreenerSortField.DAYS_TO_COVER,
    sortDirection: SortDirection.DESC,
  },
];
