/**
 * The global (non-Australian) half of the economic catalog, in ONE place.
 *
 * These series arrive from two importers — `fred-us-macro` and
 * `worldbank-pink-sheet` (services/jobs/internal/jobs/economy/) — and are
 * consumed by two unrelated surfaces: the /economy page's chart sections and
 * the industry-intelligence correlation picker. Before this file they were
 * listed only in the picker, so half of what the importers wrote was published
 * to the API and shown nowhere.
 *
 * A key here must exist in the importer. `TestGlobalSeriesRegistryMatchesImporters`
 * (services/jobs/internal/jobs/economy/registry_drift_test.go) reads this file
 * and fails the build if the two disagree in either direction — a series added
 * upstream and not surfaced, or a key here that no importer produces.
 *
 * INTERNAL-ONLY SERIES MUST NOT APPEAR HERE. VIXCLS (CBOE) and BAMLH0A0HYM2
 * (ICE Data Indices) are ingested and correlated but withheld from every public
 * read surface by migration 000121, so listing them would render a chart with
 * no line and a picker option that returns nothing. The drift test asserts
 * their absence too.
 */
import type { EconomySeriesDisplayFormat } from "@/lib/economy/map-metrics";
import type { EconomyIconName } from "@/components/economy/economy-icons.generated";

export type GlobalSeriesGroup =
  | "energy"
  | "metals"
  | "agriculture"
  | "us-rates"
  | "us-macro"
  | "currencies";

export interface GlobalSeriesDef {
  key: string;
  /**
   * Correlation-picker label. It says WHERE, always: these sit in a list next
   * to Australian indicators, and an unlabelled "10-year yield" reads as the
   * ACGB, which is a different instrument entirely.
   */
  label: string;
  /** Heading on the /economy chart card. */
  title: string;
  subtitle: string;
  source: string;
  format: EconomySeriesDisplayFormat;
  group: GlobalSeriesGroup;
  icon: EconomyIconName;
  /** Set false to chart a series without offering it as a correlation overlay. */
  overlay?: boolean;
}

export const GLOBAL_SERIES_GROUPS: {
  group: GlobalSeriesGroup;
  title: string;
  blurb: string;
}[] = [
  {
    group: "energy",
    title: "Energy — world prices",
    blurb:
      "Crude and gas. Gas does not arbitrage across oceans, so the three regional prices diverge by multiples and the spread between them is the Australian LNG export story.",
  },
  {
    group: "metals",
    title: "Metals — world prices",
    blurb:
      "What the ASX digs up: bulk, base and precious. Distinct from the RBA's commodity price indices above — an index of bulk prices is not a tonne of iron ore.",
  },
  {
    group: "agriculture",
    title: "Agriculture & fertiliser — world prices",
    blurb:
      "Grain, fibre, sugar and beef, plus the fertiliser prices that set an input cost rather than a mined volume.",
  },
  {
    group: "us-rates",
    title: "US rates",
    blurb:
      "The Treasury curve and the two spreads that carry most of the signal — 10y−2y, and the 10-year breakeven.",
  },
  {
    group: "us-macro",
    title: "US macro & money",
    blurb:
      "Prices, jobs, output and the money stock. The global risk backdrop the domestic indicators cannot show.",
  },
  {
    group: "currencies",
    title: "Currencies",
    blurb:
      "Pairs the RBA does not publish. Each product name states the direction, because the H.10 release does not quote every pair the same way round.",
  },
];

const FRED_H10 = "Federal Reserve H.10 via FRED";
const FRED_H15 = "Federal Reserve H.15 via FRED";
const PINK = "World Bank Commodity Markets (Pink Sheet)";

export const GLOBAL_ECONOMY_SERIES: GlobalSeriesDef[] = [
  // ── Energy ──────────────────────────────────────────────────────────────
  {
    key: "commodities.crude_oil.brent.eur",
    label: "Brent crude (USD/bbl)",
    title: "Brent crude",
    subtitle: "Month-end · USD per barrel",
    source: "US Energy Information Administration via FRED",
    format: "usd_price",
    group: "energy",
    icon: "mineral-fuels",
  },
  {
    key: "commodities.crude_oil.wti.usa",
    label: "WTI crude (USD/bbl)",
    title: "WTI crude",
    subtitle: "Cushing, Oklahoma · month-end · USD per barrel",
    source: "US Energy Information Administration via FRED",
    format: "usd_price",
    group: "energy",
    icon: "mineral-fuels",
  },
  {
    key: "commodities.spot_price.lng_japan.world",
    label: "LNG, Japan (USD/mmbtu)",
    title: "LNG landed Japan",
    subtitle: "Monthly · USD per mmbtu",
    source: PINK,
    format: "usd_price",
    group: "energy",
    icon: "refinery",
  },
  {
    key: "commodities.spot_price.natural_gas_europe.world",
    label: "Natural gas, Europe (USD/mmbtu)",
    title: "Natural gas — Europe",
    subtitle: "Monthly · USD per mmbtu · the marginal buyer for spot LNG cargoes",
    source: PINK,
    format: "usd_price",
    group: "energy",
    icon: "refinery",
  },
  {
    key: "commodities.spot_price.natural_gas_us.world",
    label: "Natural gas, US (USD/mmbtu)",
    title: "Natural gas — United States",
    subtitle: "Henry Hub · monthly · USD per mmbtu",
    source: PINK,
    format: "usd_price",
    group: "energy",
    icon: "refinery",
  },
  {
    key: "commodities.spot_price.coal_australian.world",
    label: "Australian thermal coal (USD/t)",
    title: "Thermal coal — Newcastle",
    subtitle: "Monthly · USD per tonne · the Australian benchmark",
    source: PINK,
    format: "usd_price",
    group: "energy",
    icon: "mineral-fuels",
  },
  {
    key: "commodities.spot_price.coal_south_african.world",
    label: "South African thermal coal (USD/t)",
    title: "Thermal coal — Richards Bay",
    subtitle:
      "Monthly · USD per tonne · the competing benchmark; the spread is the producer's margin",
    source: PINK,
    format: "usd_price",
    group: "energy",
    icon: "mineral-fuels",
  },

  // ── Metals ──────────────────────────────────────────────────────────────
  {
    key: "commodities.spot_price.iron_ore.world",
    label: "Iron ore (USD/dmtu)",
    title: "Iron ore",
    subtitle: "cfr spot, China import · monthly · USD per dmtu",
    source: PINK,
    format: "usd_price",
    group: "metals",
    icon: "crude-materials",
  },
  {
    key: "commodities.spot_price.gold.world",
    label: "Gold (USD/oz)",
    title: "Gold",
    subtitle: "Monthly · USD per troy ounce",
    source: PINK,
    format: "usd_price",
    group: "metals",
    icon: "crude-materials",
  },
  {
    key: "commodities.spot_price.silver.world",
    label: "Silver (USD/oz)",
    title: "Silver",
    subtitle: "Monthly · USD per troy ounce",
    source: PINK,
    format: "usd_price",
    group: "metals",
    icon: "crude-materials",
  },
  {
    key: "commodities.spot_price.platinum.world",
    label: "Platinum (USD/oz)",
    title: "Platinum",
    subtitle: "Monthly · USD per troy ounce",
    source: PINK,
    format: "usd_price",
    group: "metals",
    icon: "crude-materials",
  },
  {
    key: "commodities.spot_price.copper.world",
    label: "Copper (USD/t)",
    title: "Copper",
    subtitle: "LME · monthly · USD per tonne",
    source: PINK,
    format: "usd_price",
    group: "metals",
    icon: "crude-materials",
  },
  {
    key: "commodities.spot_price.aluminium.world",
    label: "Aluminium (USD/t)",
    title: "Aluminium",
    subtitle: "LME · monthly · USD per tonne",
    source: PINK,
    format: "usd_price",
    group: "metals",
    icon: "crude-materials",
  },
  {
    key: "commodities.spot_price.nickel.world",
    label: "Nickel (USD/t)",
    title: "Nickel",
    subtitle: "LME · monthly · USD per tonne",
    source: PINK,
    format: "usd_price",
    group: "metals",
    icon: "crude-materials",
  },
  {
    key: "commodities.spot_price.zinc.world",
    label: "Zinc (USD/t)",
    title: "Zinc",
    subtitle: "LME · monthly · USD per tonne",
    source: PINK,
    format: "usd_price",
    group: "metals",
    icon: "crude-materials",
  },
  {
    key: "commodities.spot_price.lead.world",
    label: "Lead (USD/t)",
    title: "Lead",
    subtitle: "LME · monthly · USD per tonne",
    source: PINK,
    format: "usd_price",
    group: "metals",
    icon: "crude-materials",
  },
  {
    key: "commodities.spot_price.tin.world",
    label: "Tin (USD/t)",
    title: "Tin",
    subtitle: "LME · monthly · USD per tonne",
    source: PINK,
    format: "usd_price",
    group: "metals",
    icon: "crude-materials",
  },

  // ── Agriculture & fertiliser ────────────────────────────────────────────
  {
    key: "commodities.spot_price.wheat_us_hrw.world",
    label: "Wheat, US HRW (USD/t)",
    title: "Wheat",
    subtitle: "US hard red winter, fob Gulf · monthly · USD per tonne",
    source: PINK,
    format: "usd_price",
    group: "agriculture",
    icon: "food",
  },
  {
    key: "commodities.spot_price.beef.world",
    label: "Beef (USD/kg)",
    title: "Beef",
    subtitle: "Australian and New Zealand, cif US · monthly · USD per kg",
    source: PINK,
    format: "usd_price",
    group: "agriculture",
    icon: "food",
  },
  {
    key: "commodities.spot_price.sugar.world",
    label: "Sugar (USD/kg)",
    title: "Sugar",
    subtitle: "Raw, world price · monthly · USD per kg",
    source: PINK,
    format: "usd_price",
    group: "agriculture",
    icon: "food",
  },
  {
    key: "commodities.spot_price.cotton.world",
    label: "Cotton (USD/kg)",
    title: "Cotton",
    subtitle: "Cotlook A index · monthly · USD per kg",
    source: PINK,
    format: "usd_price",
    group: "agriculture",
    icon: "oils-fats",
  },
  {
    key: "commodities.spot_price.urea.world",
    label: "Urea (USD/t)",
    title: "Urea",
    subtitle: "Granular, fob · monthly · USD per tonne",
    source: PINK,
    format: "usd_price",
    group: "agriculture",
    icon: "chemicals",
  },
  {
    key: "commodities.spot_price.dap.world",
    label: "DAP (USD/t)",
    title: "Diammonium phosphate",
    subtitle: "fob · monthly · USD per tonne",
    source: PINK,
    format: "usd_price",
    group: "agriculture",
    icon: "chemicals",
  },
  {
    key: "commodities.spot_price.phosphate_rock.world",
    label: "Phosphate rock (USD/t)",
    title: "Phosphate rock",
    subtitle: "fob · monthly · USD per tonne",
    source: PINK,
    format: "usd_price",
    group: "agriculture",
    icon: "chemicals",
  },
  {
    key: "commodities.spot_price.potassium_chloride.world",
    label: "Potash (USD/t)",
    title: "Potassium chloride",
    subtitle: "Muriate of potash, fob · monthly · USD per tonne",
    source: PINK,
    format: "usd_price",
    group: "agriculture",
    icon: "chemicals",
  },

  // ── US rates ────────────────────────────────────────────────────────────
  {
    key: "rates.policy_rate.fed_funds.usa",
    label: "US fed funds rate",
    title: "Federal funds effective rate",
    subtitle: "Monthly average · per cent · the US counterpart to the RBA cash rate",
    source: FRED_H15,
    format: "percent",
    group: "us-rates",
    icon: "cash-rate",
  },
  {
    key: "rates.treasury_yield.3m.usa",
    label: "US 3-month Treasury yield",
    title: "US 3-month Treasury yield",
    subtitle: "Constant maturity · month-end · per cent",
    source: FRED_H15,
    format: "percent",
    group: "us-rates",
    icon: "cash-rate",
  },
  {
    key: "rates.treasury_yield.2y.usa",
    label: "US 2-year Treasury yield",
    title: "US 2-year Treasury yield",
    subtitle: "Constant maturity · month-end · per cent",
    source: FRED_H15,
    format: "percent",
    group: "us-rates",
    icon: "cash-rate",
  },
  {
    key: "rates.treasury_yield.10y.usa",
    label: "US 10-year Treasury yield",
    title: "US 10-year Treasury yield",
    subtitle: "Constant maturity · month-end · per cent",
    source: FRED_H15,
    format: "percent",
    group: "us-rates",
    icon: "cash-rate",
  },
  {
    key: "rates.treasury_yield.30y.usa",
    label: "US 30-year Treasury yield",
    title: "US 30-year Treasury yield",
    subtitle: "Constant maturity · month-end · per cent",
    source: FRED_H15,
    format: "percent",
    group: "us-rates",
    icon: "cash-rate",
  },
  {
    key: "rates.yield_curve_spread.10y_2y.usa",
    label: "US 10y−2y spread",
    title: "US yield curve — 10y minus 2y",
    subtitle: "Month-end · percentage points · below zero is an inverted curve",
    source: FRED_H15,
    format: "percent",
    group: "us-rates",
    icon: "cash-rate",
  },
  {
    key: "rates.breakeven_inflation.10y.usa",
    label: "US 10-year breakeven inflation",
    title: "US 10-year breakeven inflation",
    subtitle: "Nominal minus TIPS · month-end · per cent",
    source: FRED_H15,
    format: "percent",
    group: "us-rates",
    icon: "cpi",
  },

  // ── US macro & money ────────────────────────────────────────────────────
  {
    key: "cpi.index.all_items.usa.seasadj",
    label: "US CPI (index)",
    title: "US consumer price index",
    subtitle: "All items, seasonally adjusted · monthly · 1982-84 = 100",
    source: "US Bureau of Labor Statistics via FRED",
    format: "index",
    group: "us-macro",
    icon: "cpi",
  },
  {
    key: "labour.unemployment_rate.total.usa.seasadj",
    label: "US unemployment rate",
    title: "US unemployment rate",
    subtitle: "Seasonally adjusted · monthly · per cent",
    source: "US Bureau of Labor Statistics via FRED",
    format: "percent",
    group: "us-macro",
    icon: "unemployment",
  },
  {
    key: "industry.production_index.total.usa.seasadj",
    label: "US industrial production",
    title: "US industrial production",
    subtitle: "Total index, seasonally adjusted · monthly · 2017 = 100",
    source: "Federal Reserve G.17 via FRED",
    format: "index",
    group: "us-macro",
    icon: "machinery-transport",
  },
  {
    key: "money.m2_stock.total.usa.seasadj",
    label: "US M2 money stock",
    title: "US M2 money stock",
    subtitle: "Seasonally adjusted · monthly · USD billions",
    source: "Federal Reserve H.6 via FRED",
    format: "number",
    group: "us-macro",
    icon: "state-finances",
  },
  {
    key: "money.central_bank_assets.total.usa",
    label: "Fed balance sheet",
    title: "Federal Reserve total assets",
    subtitle: "Month-end · USD millions",
    source: "Federal Reserve H.4.1 via FRED",
    format: "number",
    group: "us-macro",
    icon: "state-finances",
  },

  // ── Currencies ──────────────────────────────────────────────────────────
  // AUD/USD is DELIBERATELY ABSENT: the RBA importer already owns it as
  // rates.aud_usd.aus (charted in the Macro section above), and a second
  // AUD/USD from a second publisher would be two series claiming one fact.
  {
    key: "fx.usd_index.broad.usa",
    label: "US dollar index (broad)",
    title: "US dollar index — broad",
    subtitle: "Nominal, Jan 2006 = 100 · month-end",
    source: FRED_H10,
    format: "index",
    group: "currencies",
    icon: "aud-usd",
  },
  {
    key: "fx.spot_rate.cny_usd.chn",
    label: "Chinese yuan per USD",
    title: "Chinese yuan per US dollar",
    subtitle: "Month-end · China takes the bulk of Australian iron ore",
    source: FRED_H10,
    format: "fx",
    group: "currencies",
    icon: "aud-usd",
  },
  {
    key: "fx.spot_rate.jpy_usd.jpn",
    label: "Japanese yen per USD",
    title: "Japanese yen per US dollar",
    subtitle: "Month-end",
    source: FRED_H10,
    format: "fx",
    group: "currencies",
    icon: "aud-usd",
  },
  {
    key: "fx.spot_rate.krw_usd.kor",
    label: "South Korean won per USD",
    title: "South Korean won per US dollar",
    subtitle: "Month-end",
    source: FRED_H10,
    format: "fx",
    group: "currencies",
    icon: "aud-usd",
  },
  {
    key: "fx.spot_rate.inr_usd.ind",
    label: "Indian rupees per USD",
    title: "Indian rupees per US dollar",
    subtitle: "Month-end",
    source: FRED_H10,
    format: "fx",
    group: "currencies",
    icon: "aud-usd",
  },
  {
    key: "fx.spot_rate.sgd_usd.sgp",
    label: "Singapore dollars per USD",
    title: "Singapore dollars per US dollar",
    subtitle: "Month-end",
    source: FRED_H10,
    format: "fx",
    group: "currencies",
    icon: "aud-usd",
  },
  {
    key: "fx.spot_rate.cad_usd.can",
    label: "Canadian dollars per USD",
    title: "Canadian dollars per US dollar",
    subtitle: "Month-end · the other resources-heavy G10 currency",
    source: FRED_H10,
    format: "fx",
    group: "currencies",
    icon: "aud-usd",
  },
  {
    key: "fx.spot_rate.usd_eur.eur",
    label: "USD per euro",
    title: "US dollars per euro",
    subtitle: "Month-end",
    source: FRED_H10,
    format: "fx",
    group: "currencies",
    icon: "aud-usd",
  },
  {
    key: "fx.spot_rate.usd_gbp.gbr",
    label: "USD per pound sterling",
    title: "US dollars per pound sterling",
    subtitle: "Month-end",
    source: FRED_H10,
    format: "fx",
    group: "currencies",
    icon: "aud-usd",
  },
  {
    key: "fx.spot_rate.usd_nzd.nzl",
    label: "USD per New Zealand dollar",
    title: "US dollars per New Zealand dollar",
    subtitle: "Month-end",
    source: FRED_H10,
    format: "fx",
    group: "currencies",
    icon: "aud-usd",
  },
];

/** Group title for the correlation picker, keyed by group. */
export const GLOBAL_GROUP_TITLES: Record<GlobalSeriesGroup, string> =
  Object.fromEntries(
    GLOBAL_SERIES_GROUPS.map(({ group, title }) => [group, title]),
  ) as Record<GlobalSeriesGroup, string>;

export function globalSeriesInGroup(group: GlobalSeriesGroup): GlobalSeriesDef[] {
  return GLOBAL_ECONOMY_SERIES.filter((series) => series.group === group);
}
