// Housing ranking registry — the single source of truth for
// /housing/rankings/[slug].
//
// A ranking is a fixed-URL, state-scoped ordering of the suburb summaries
// returned by HousingService.ListStateSuburbs. Every ranking excludes suburbs
// with no price (`latestMedianPrice === 0`) and populations below 200: an absent
// price must never appear as "$0", while tiny ABS Statistical Areas can produce
// volatile, privacy-affected medians. Affordability also requires a positive
// median weekly household income.
//
// Prices are derived from state Valuer-General records and demographics from
// the ABS Census, exposed together in the suburb dataset. The page reports
// the newest available price period; Census income and population have their
// own, slower vintage. These are descriptive rankings, not forecasts or advice.
//
// Everything exported here stays serializable (no functions inside ranking
// records) because server pages and the housing sitemap both import it. To add
// a ranking, add its serializable metric copy and one distinct blurb per state;
// the state × metric expansion supplies its slug, SEO fields and sibling links.

import { ALL_STATES, STATE_NAMES } from "~/@/lib/housing/states";
import type { RankingMetric } from "./rank";

export type { RankingMetric } from "./rank";

type StateCode = "NSW" | "VIC" | "QLD" | "SA" | "WA" | "TAS" | "NT" | "ACT";

export interface RankingDefinition {
  slug: string;
  stateCode: StateCode;
  metric: RankingMetric;
  /** <title> without the "| Shorted" suffix (the root layout appends it). */
  title: string;
  h1: string;
  /** Query-targeted meta description, approximately 155 characters. */
  description: string;
  keywords: string[];
  /** One-sentence introduction shown below the H1. */
  dek: string;
  /** 120–160 words of unique, factual, server-rendered editorial copy. */
  blurb: string;
  /** Slugs of other useful housing rankings. */
  related: string[];
}

interface MetricCopy {
  slugPrefix: string;
  titlePrefix: string;
  h1Prefix: string;
  descriptionLead: string;
  keywordLead: string;
  dekLead: string;
}

const METRIC_ORDER: RankingMetric[] = [
  "price-asc",
  "price-desc",
  "growth-desc",
  "growth-asc",
  "affordability",
];

const METRIC_COPY: Record<RankingMetric, MetricCopy> = {
  "price-asc": {
    slugPrefix: "cheapest-suburbs",
    titlePrefix: "Cheapest Suburbs",
    h1Prefix: "Cheapest Suburbs",
    descriptionLead: "Cheapest suburbs",
    keywordLead: "cheapest suburbs",
    dekLead: "The lowest latest median house prices",
  },
  "price-desc": {
    slugPrefix: "most-expensive-suburbs",
    titlePrefix: "Most Expensive Suburbs",
    h1Prefix: "Most Expensive Suburbs",
    descriptionLead: "Most expensive suburbs",
    keywordLead: "most expensive suburbs",
    dekLead: "The highest latest median house prices",
  },
  "growth-desc": {
    slugPrefix: "fastest-growing-suburbs",
    titlePrefix: "Fastest-Growing Suburbs",
    h1Prefix: "Fastest-Growing Suburbs",
    descriptionLead: "Fastest-growing suburb prices",
    keywordLead: "fastest growing suburbs",
    dekLead: "The strongest year-on-year median house-price changes",
  },
  "growth-asc": {
    slugPrefix: "fastest-falling-suburbs",
    titlePrefix: "Fastest-Falling Suburbs",
    h1Prefix: "Fastest-Falling Suburbs",
    descriptionLead: "Largest suburb price falls",
    keywordLead: "falling suburb prices",
    dekLead: "The weakest year-on-year median house-price changes",
  },
  affordability: {
    slugPrefix: "most-affordable-suburbs",
    titlePrefix: "Most Affordable Suburbs",
    h1Prefix: "Most Affordable Suburbs",
    descriptionLead: "Most affordable suburbs",
    keywordLead: "most affordable suburbs",
    dekLead: "The lowest median house-price-to-household-income ratios",
  },
};

const BLURBS: Record<StateCode, Record<RankingMetric, string>> = {
  NSW: {
    "price-asc":
      "This ranking orders New South Wales suburbs from the lowest latest median house price upward. It uses the price attached to each suburb in the suburb dataset, derived from state Valuer-General records, alongside ABS Census population data. Suburbs without a recorded price and those with fewer than 200 residents are removed before sorting, so a missing observation cannot masquerade as a bargain and tiny areas do not dominate the list. The period shown on the page is the newest price period present in the state response, although individual suburbs may have different transaction vintages. A low median describes the middle observed sale price, not the cost of every dwelling. It does not adjust for property type, land size, condition, sales volume or distance from services, and it is neither a valuation nor a recommendation.",
    "price-desc":
      "New South Wales suburbs appear here in descending order of their latest recorded median house price. The underlying suburb summaries combine Valuer-General-derived price observations with ABS Census population and income fields, published at suburb level. Unpriced suburbs are excluded rather than displayed as zero, and the 200-resident floor reduces the chance that a very small Statistical Area produces a misleading headline median. The page reports the freshest period found in the state data, but that does not guarantee identical sale windows for every row. Expensive medians can reflect dwelling mix, scarce turnover, larger lots or a handful of transactions as well as location demand. This table does not measure quality, future returns, borrowing capacity or the price of a particular address; it is a descriptive comparison of published suburb-level medians only.",
    "growth-desc":
      "This New South Wales table ranks suburbs by the largest positive year-on-year change in median house price. Growth is the year-on-year change published for each priced suburb, whose price series is derived from state Valuer-General records; population comes from the ABS Census. Rows with no current median or fewer than 200 residents are removed before the percentages are compared. The displayed data period identifies the newest observation available across the response, while coverage can still vary by suburb. A rising median is not a repeat-sales index: the mix of homes sold in two periods can change, especially where turnover is light. Consequently, the result describes movement in published medians rather than capital growth for every property. It is historical, does not forecast the next period and should not be treated as investment or purchasing advice.",
    "growth-asc":
      "This ranking surfaces the weakest year-on-year median house-price changes reported for New South Wales suburbs, sorting the year-on-year change from lowest upward. Prices are derived from state Valuer-General data and published alongside ABS Census demographics. A suburb must have a positive latest median and at least 200 residents to enter the comparison; this prevents absent prices and tiny Statistical Areas from creating artificial falls. The as-of label reflects the newest price period in the returned state set, not necessarily a perfectly synchronized sales window for every locality. A negative median change can arise from a different mix of dwellings or limited transactions, not only from like-for-like homes losing value. The table is therefore a factual screen of published suburb medians, not an appraisal, a distress indicator, a forecast or advice about buying or selling.",
    affordability:
      "For New South Wales, this ranking divides each suburb's latest median house price by 52 weeks of its median weekly household income, then orders the resulting price-to-income ratios from lowest to highest. Price observations are Valuer-General-derived; income and population come from the ABS Census, joined at suburb level. Suburbs need a positive price, positive income and at least 200 residents. That keeps missing values out of the arithmetic and limits unstable results from very small areas. The two inputs do not share the same vintage: Census income changes slowly while the page reports the newest available property-price period. The ratio is a broad local comparison, not a mortgage-serviceability calculation. It ignores deposits, interest rates, taxes, household composition, dwelling quality and income distribution, and it is not a claim that a particular home is affordable for a particular buyer.",
  },
  VIC: {
    "price-asc":
      "Victoria's lowest-price ranking compares the latest suburb median house prices published for each suburb, from the smallest upward. Those medians are derived from state Valuer-General records and paired with ABS Census population data. Any zero price is treated as missing and removed, while suburbs below 200 residents are also excluded because a tiny population can produce an unstable or privacy-affected median. The freshness line uses the latest price period found in the Victorian response; some suburb observations may still refer to earlier transaction windows. This is a ranking of medians, not a catalogue of homes available at that figure. Differences in housing type, block size, condition and turnover remain inside each number. The list does not account for commuting costs, amenities or financing, makes no prediction about future prices and should not be read as personal property advice.",
    "price-desc":
      "This table starts with Victoria's highest latest median house price and works downward through eligible suburbs. The suburb summaries draw price data from Valuer-General sources and demographic context from the ABS Census. A zero median means no usable price observation, so it never appears as $0; areas with fewer than 200 residents are screened out to avoid fragile comparisons based on very small Statistical Areas. The newest period in the response is shown as the data vintage, although individual suburb medians can cover different sale periods. A high midpoint can be shaped by the kinds of properties that happened to transact and by low turnover. It is not a measure of live asking prices, prestige, rental yield or likely appreciation, and it cannot value an individual Victorian property.",
    "growth-desc":
      "Victorian suburbs are ordered here by year-on-year median house-price change, with the largest reported increase first. The ranking uses the published year-on-year change and latest median, based on state Valuer-General-derived sales data, and applies the ABS Census population field as a quality screen. Unpriced suburbs and places with fewer than 200 residents are left out. The page's period is the most recent price timestamp present in the state response rather than a guarantee that every suburb was measured over precisely the same transactions. Median growth is sensitive to sales composition: more large homes selling this year can lift the midpoint even if comparable dwellings are unchanged. This historical list therefore measures changes in published suburb medians, not owners' realized returns. It offers no forecast, market timing signal or recommendation about where to purchase property.",
    "growth-asc":
      "The Victorian suburbs with the lowest year-on-year median price changes lead this table. It sorts the year-on-year change observations supplied in the suburb dataset after removing records with no positive median and ABS Statistical Areas below the 200-resident threshold. Prices come from state Valuer-General-derived records, while population and household context come from the ABS Census. The newest period available anywhere in the response is disclosed, but suburb transaction windows and sample sizes may differ. A falling median can reflect which homes sold, not a uniform repricing of every address; sparse turnover makes that distinction particularly important. The ranking is useful for describing the lower end of the reported change distribution, but it is not a repeat-sales measure, a prediction, evidence of forced selling or advice to buy, hold or sell in Victoria.",
    affordability:
      "This Victorian affordability comparison converts median weekly household income to an annual figure and divides each suburb's latest median house price by it. Lower ratios rank first. the suburb dataset joins Valuer-General-derived prices to ABS Census income and population, and the calculation accepts only positive prices, positive incomes and populations of at least 200. The threshold prevents missing data or very small localities from generating deceptively strong ratios. Price freshness is shown from the newest period in the Victorian response, whereas Census income comes from a slower, separate collection cycle. Price-to-income is deliberately simple: it does not incorporate mortgage rates, deposits, stamp duty, household size, debt or the spread of incomes within a suburb. It describes two suburb medians at different vintages and is neither a lending assessment nor a recommendation for an individual household.",
  },
  QLD: {
    "price-asc":
      "Queensland suburbs in this list are sorted by the lowest positive latest median house price reported in the suburb dataset. The service combines state Valuer-General-derived price records with ABS Census demographics. Records without price coverage are omitted entirely, rather than being labelled $0, and suburbs under 200 residents are removed because their medians can be dominated by very few observations. The page identifies the newest price period returned for Queensland, but coverage and transaction timing may not be uniform across the state. Median price is the midpoint of the observed distribution, not a promise that a suitable dwelling can be bought for that amount. The comparison leaves property type, land area, condition, insurance, access and sales volume unadjusted. It is descriptive public-data analysis, not a valuation, affordability test, future-price estimate or recommendation to transact.",
    "price-desc":
      "Queensland's most expensive ranking places the largest latest suburb median house price first. Source observations arrive in the suburb dataset: prices are derived from Valuer-General records and population is sourced from the ABS Census. The calculation excludes every zero-price record as missing and applies a minimum population of 200, which reduces noise from tiny Statistical Areas where a small number of sales can move a median sharply. The as-of date is the newest price period found in the state payload; individual rows may have older effective periods. A high median does not reveal the number, size or condition of dwellings sold and is not equivalent to a current listing price. Nor does this ordering measure desirability, value for money or expected return. It is a state-scoped snapshot and not property, credit or investment advice.",
    "growth-desc":
      "This Queensland ranking orders positive-price suburbs by their reported year-on-year median change, highest first. The year-on-year change measure is supplied in the suburb dataset from Valuer-General-derived price data, with ABS Census population used to exclude areas below 200 residents. Suburbs without a latest median cannot enter the table, ensuring absent coverage never becomes an apparent growth result. The freshness label takes the newest price period in the state response, although each suburb's underlying sale mix may differ. Year-on-year median movement is not the same as a matched-property return: a shift toward larger, newer or differently located sales can change the midpoint. The ranking records what the suburb-level series says at the latest available vintage. It does not predict continuation, compare risk, estimate a home's value or recommend any Queensland market.",
    "growth-asc":
      "The lowest year-on-year suburb median changes reported for Queensland appear first here, including negative movements where present. The suburb dataset provides year-on-year change and latest median price from Valuer-General-derived records plus ABS Census population. A row qualifies only with a positive price and at least 200 residents, so unpriced localities and tiny areas cannot be mistaken for the steepest falls. The period shown is the freshest one anywhere in the state result, not proof of identical observation windows. Changes in the mix and count of sold homes can pull a median down without every comparable property falling by the same percentage. This makes the list a screen of published aggregate movement rather than a repeat-sales index or measure of owner equity. It is historical information, not a forecast of further declines, a distress signal or buying advice.",
    affordability:
      "Queensland suburbs are ranked here by latest median house price divided by annualized median household income, with the smallest multiple first. The source is the suburb dataset, which brings together Valuer-General-derived prices and ABS Census income and population. Price and weekly income must both be greater than zero, and population must reach 200, before a ratio is calculated. Those rules stop incomplete records and very small Statistical Areas from looking artificially affordable. The latest state price period is disclosed, while the income measure retains its Census vintage and therefore does not update alongside property sales. This ratio is not a household budget: it omits interest rates, deposits, insurance, taxes, existing debts, family size and dwelling differences. It compares aggregate suburb midpoints only and should not be taken as finance eligibility, valuation or personal advice.",
  },
  SA: {
    "price-asc":
      "South Australian suburbs are arranged here from the lowest latest recorded median house price to the highest. the suburb dataset supplies Valuer-General-derived price observations together with ABS Census population data. A latest median price of zero is missing coverage and is excluded, never presented as a free or ultra-cheap market; Statistical Areas with fewer than 200 residents are also removed to reduce unstable medians from tiny populations. The page's vintage is the newest price period present in the state response, though not every suburb necessarily shares that exact sales window. A suburb median compresses varied houses and transaction counts into one midpoint. It says nothing about a particular dwelling's size, condition, availability or asking price. This ranking is a factual state comparison, not an assessment of live inventory, financing, future performance or suitability for an individual buyer.",
    "price-desc":
      "This ranking compares South Australia's largest suburb median house prices using the latest positive value in the suburb dataset. Price records are derived from the state Valuer-General stream and joined to ABS Census population information. Unpriced suburbs are removed rather than allowed to display $0, and a 200-resident minimum guards against tiny Statistical Areas creating outsized medians. The page publishes the freshest price period found across the state payload, while some local series can have different effective dates or transaction counts. The top of the table reflects observed median prices, not necessarily the most expensive individual sales or today's asking market. Housing mix, lot sizes and turnover can materially influence position. No row is a valuation, quality score, forecast, return estimate or advice about purchasing or selling South Australian property.",
    "growth-desc":
      "South Australia's fastest-growing table sorts the latest reported year-on-year change values from highest to lowest among priced suburbs. the suburb dataset carries the Valuer-General-derived median series and ABS Census population used by the filter. A suburb with no positive median or fewer than 200 residents is excluded before ranking, because missing prices and very small populations can create meaningless extremes. The newest available price period in the state response appears on the page, but each percentage remains an aggregate of its suburb's own sales windows. A changing sales mix can lift a median even when comparable houses have not risen by the same rate. The list therefore describes year-on-year movement in published medians rather than guaranteed property-level appreciation. It is not a momentum forecast, a measure of market depth or a recommendation about any suburb.",
    "growth-asc":
      "This South Australian view begins with the weakest year-on-year median house-price result and sorts upward. The year-on-year change field and positive median requirement come from the suburb dataset's Valuer-General-derived price data; the ABS Census population field enforces a minimum of 200 residents. That combination removes unpriced records and limits extreme rankings from tiny Statistical Areas. The freshness note uses the latest price period returned for the state, although suburb-level observation windows and sale counts can vary. A lower median may reflect a different selection of transacted homes, particularly where turnover is modest, rather than a uniform change across the local housing stock. These results are descriptive aggregates only. They do not identify mortgage stress, predict subsequent prices, value an address or constitute advice to enter or leave a South Australian market.",
    affordability:
      "This South Australian ranking compares a suburb's latest median house price with 52 times its ABS median weekly household income. Lower price-to-income multiples appear first. the suburb dataset joins Valuer-General-derived prices and Census demographics, and only records with positive values for both measures and at least 200 residents are eligible. This prevents missing inputs and tiny localities from producing false affordability leaders. The price period displayed is the freshest in the state response; income remains tied to its less frequent Census vintage, so the ratio mixes collection dates by design. It is a broad spatial indicator, not a mortgage calculator. Interest rates, deposits, transaction costs, debts, household composition, dwelling characteristics and income inequality are outside the measure. The ordering does not establish what any household can borrow or recommend where it should live.",
  },
  WA: {
    "price-asc":
      "Western Australian suburbs with the lowest positive latest median house prices lead this state ranking. The values come in the suburb dataset from Valuer-General-derived records, alongside ABS Census population fields and the service's priced-region coding. A zero latest median denotes no usable price coverage and is excluded, while the 200-resident threshold screens out tiny Statistical Areas whose medians can be unstable. The page states the newest price period present in the Western Australian response; data availability and timing may still differ between suburbs. A median is the midpoint of observed sales, not a quote for a home currently on the market. The list does not normalize dwelling type, lot size, condition, remoteness, services or turnover. It supplies a transparent price ordering, not a valuation, cost-of-living calculation, prediction or recommendation.",
    "price-desc":
      "This Western Australian table orders eligible suburbs by latest median house price from highest to lowest. the suburb dataset exposes Valuer-General-derived prices, ABS Census population and the region code used to connect priced areas to their series. Unpriced records are dropped rather than rendered at zero; suburbs below 200 residents are also excluded so very small Statistical Areas do not lead on a fragile median. The latest period anywhere in the state payload becomes the freshness label, although individual suburb series may not be synchronous. An expensive midpoint may reflect a different dwelling mix or only a small volume of transactions. It does not represent every home's current value, the highest sale, rental economics or likely growth. This is historical aggregate data and not property, investment or lending advice.",
    "growth-desc":
      "Western Australian suburbs are ranked by descending year-on-year change in this view, using only rows with a real latest median. the suburb dataset supplies the change measure from Valuer-General-derived prices and population from the ABS Census, together with region codes for priced series. Areas below 200 residents and zero-price records are removed before sorting. The page reports the freshest price period in the returned state set, but coverage, sale counts and exact periods can vary by suburb. Year-on-year median growth can move when the composition of sold homes changes; it is not a matched sample of identical dwellings. Accordingly, the table records the strongest published median changes rather than guaranteed gains for owners or buyers. It offers no forecast of persistence, assessment of liquidity, individual valuation or recommendation about Western Australian property.",
    "growth-asc":
      "This ranking puts Western Australia's lowest reported year-on-year suburb median changes first. It reads year-on-year change and latest median price from the suburb dataset's Valuer-General-derived data, uses ABS Census population, and retains only priced areas with at least 200 residents. Those gates prevent a missing series or tiny Statistical Area from appearing as a dramatic decline. The displayed vintage is the newest price period present across the state response, while an individual suburb may reflect a different transaction window. Median movement can be driven by which kinds of homes sold and by low turnover, so it should not be treated as a like-for-like fall across every address. The table is a historical comparison of published aggregates, not evidence of distress, a forecast, a current appraisal or a signal to transact.",
    affordability:
      "Western Australian suburbs enter this list when the suburb dataset contains a positive median house price, a positive ABS median weekly household income and at least 200 residents. The price, derived from Valuer-General records, is divided by 52 weeks of income; the lowest multiple ranks first. Region coding identifies priced series, while zero-price areas remain absent instead of becoming artificial affordability winners. The page shows the newest property period found in the state response, but Census income updates on a different timetable. Price-to-income offers a consistent broad comparison, not a complete housing budget. It excludes deposits, interest rates, transaction costs, existing debt, household size, dwelling condition and local income dispersion. A lower multiple neither guarantees mortgage approval nor says that an available home suits a particular household, and the ranking is not advice.",
  },
  TAS: {
    "price-asc":
      "Tasmanian suburbs are sorted here from the lowest positive latest median house price reported in the suburb dataset. The service combines Valuer-General-derived price observations with ABS Census population data. Where latest median price is zero, the record is treated as unpriced and omitted rather than displayed as $0. The population floor of 200 also matters in Tasmania because very small Statistical Areas can yield medians based on limited and volatile observations. The page names the newest price period in the state result, while individual suburb coverage may differ. Median price summarizes the middle transaction, not the range, condition or availability of local homes. This table does not adjust for dwelling mix, land, access, services or sale volume, and it is not a valuation, future-price forecast or recommendation about a Tasmanian location.",
    "price-desc":
      "This Tasmanian comparison begins with the highest latest median house price among eligible suburbs. The suburb dataset provides Valuer-General-derived price records and ABS Census population context. A suburb needs a positive median and at least 200 residents; absent price data therefore cannot read as zero, and tiny areas are less likely to occupy the extremes on a thin sample. The freshness statement uses the newest property period found in the Tasmania payload, not a promise that every row shares an identical window. High medians can reflect the type and small number of houses sold as much as broad market levels. The ranking does not measure live listings, housing quality, rental yield or expected appreciation. It is a descriptive ordering of aggregate observations, not an appraisal or personal financial advice.",
    "growth-desc":
      "Tasmania's strongest reported year-on-year suburb median changes appear first in this ranking. The year-on-year change field comes from the suburb dataset's Valuer-General-derived price series, and ABS Census population supplies a 200-resident eligibility floor. Rows with no positive latest median are removed, avoiding false growth signals from missing coverage. The newest price period returned for the state is displayed, although local sale counts and effective periods may vary. That distinction is important in smaller markets: a different mix of dwellings can move the median without equivalent appreciation in every comparable home. The table captures movement in published suburb aggregates and nothing more. It is not a repeat-sales index, prediction of continuing growth, liquidity measure, valuation for an address or recommendation to buy property in Tasmania.",
    "growth-asc":
      "This Tasmanian table orders eligible suburbs from the lowest year-on-year change upward, showing where published median house-price change has been weakest. the suburb dataset joins Valuer-General-derived prices with ABS Census population. Unpriced rows and areas below 200 residents are excluded before sorting, reducing the influence of missing observations and very small Statistical Areas. The date shown is the latest price period found across the state response; transaction windows and volumes can still differ between localities. A negative or low median movement can result from the composition of sales, especially when only a modest number of homes changes hands. It should not be generalized to every dwelling or owner. The ranking is retrospective public-data analysis, not a distress test, appraisal, prediction or instruction to purchase or sell.",
    affordability:
      "For Tasmania, affordability is expressed as latest median house price divided by annualized median weekly household income. The suburb dataset provides the Valuer-General-derived price and the ABS Census income and population fields. A valid row needs both monetary inputs above zero and at least 200 residents, so missing coverage and tiny Statistical Areas do not become spurious low-ratio leaders. The newest state price period appears on the page, but the Census income denominator comes from its own slower vintage. The ratio helps compare aggregate suburb midpoints on one consistent formula; it does not reproduce a household's finances. Mortgage rates, deposits, transfer costs, other debt, family composition, dwelling type and the distribution around each median are omitted. Consequently, this list is neither a borrowing assessment nor a claim that a particular Tasmanian home is attainable.",
  },
  NT: {
    "price-asc":
      "Northern Territory suburbs with the lowest available median house prices rank first here. the suburb dataset supplies Valuer-General-derived prices and ABS Census population, and only positive price observations are used. Areas with fewer than 200 residents are also excluded: in a jurisdiction with many small Statistical Areas, a tiny population can produce an especially unstable median or no publishable result. The page displays the newest price period present in the Territory response, while coverage and transaction windows can vary by suburb. A low median is the middle of recorded sales, not a guaranteed entry price or a complete cost comparison. Dwelling mix, land, condition, access, insurance, services and turnover are not controlled. This is a transparent ranking of available aggregate data, not a valuation, forecast, suitability test or recommendation about where to live or invest.",
    "price-desc":
      "This Northern Territory ranking sorts positive latest suburb median house prices from highest to lowest. The observations are published for each suburb, drawing on Valuer-General-derived records and ABS Census population. Zero-price rows are missing data and never render as $0; the minimum population of 200 limits misleading extremes from very small Statistical Areas. The freshness label reflects the latest period found in the Territory response, although each suburb may have a different sales window and transaction count. A high median can be shaped by the homes that happened to sell and does not set the current value of every address. The ordering omits property condition, lot size, availability and ongoing ownership costs. It is historical descriptive analysis, not a prestige score, expected-return measure, appraisal or financial recommendation.",
    "growth-desc":
      "Northern Territory suburbs are ordered by their largest reported year-on-year median house-price changes in this table. The year-on-year change values and positive prices come from the suburb dataset's Valuer-General-derived series, while ABS Census population enforces a 200-resident minimum. Unpriced and smaller areas remain outside the ranking so missing coverage and thin populations cannot manufacture extreme growth. The page reports the newest price period in the Territory result; individual observations may still cover different transactions. Changes in the number and mix of homes sold can shift a median markedly in smaller markets, so the percentage is not a like-for-like return for all properties. This list describes the latest published aggregate movement. It does not forecast continuation, measure market depth, value a dwelling or recommend a Northern Territory suburb.",
    "growth-asc":
      "This view starts with the Northern Territory's weakest year-on-year suburb median price changes. It sorts year-on-year change from the suburb dataset after requiring a positive Valuer-General-derived median and an ABS Census population of at least 200. Those filters exclude absent price series and reduce unstable results from tiny Statistical Areas. The date on the page is the newest property period available across the Territory response, not necessarily the exact period behind every row. Where turnover is limited, a change in which dwelling types sold can lower the median without matching declines across comparable properties. The ranking should therefore be read as an aggregate historical screen, not a repeat-sales measure or statement about every owner's equity. It is not a forecast of further falls, an appraisal, evidence of distress or personal property advice.",
    affordability:
      "This Northern Territory comparison ranks the ratio of latest median house price to 52 weeks of median household income. Price is Valuer-General-derived and income and population are from the ABS Census, joined in the suburb dataset. Both monetary fields must be positive and each area must have at least 200 residents before it is ranked. That prevents unpriced or very small Statistical Areas from appearing deceptively affordable. The page's freshness date follows the newest property observation returned for the Territory, whereas the income denominator keeps its Census vintage. The multiple is an intentionally narrow comparison, not a cost-of-living or loan-serviceability model. It ignores deposits, interest, insurance, transport, taxes, debts, household size and dwelling differences. A low ratio does not establish available stock, lending eligibility or suitability for any individual household.",
  },
  ACT: {
    "price-asc":
      "Australian Capital Territory suburbs are ranked from the lowest positive latest median house price in this table. the suburb dataset combines Valuer-General-derived price observations with ABS Census population. A zero median indicates no usable coverage and is removed, not shown as $0; suburbs under 200 residents are also excluded because small Statistical Areas can generate unstable midpoints. The page cites the newest price period available across the Territory response, while individual suburb medians may span different transactions. The result is not a list of properties currently for sale at the displayed figure. House style, block size, condition, sales volume and location within a suburb remain unadjusted. This is a state-equivalent comparison of published medians, not an individual valuation, complete affordability analysis, forecast or recommendation about buying in Canberra.",
    "price-desc":
      "This ACT table places the highest eligible suburb median house price first. The source, the suburb dataset, joins Valuer-General-derived prices to ABS Census population data. Unpriced areas are excluded rather than treated as zero, and the 200-resident floor keeps tiny Statistical Areas from dominating a ranking with fragile medians. The freshness line uses the newest property period in the Territory response; each row can still reflect its own sales count and effective window. A high median records the middle observed transaction price, not the value of every home or the maximum sale. Differences in dwelling mix, land and turnover are not normalized. The ranking does not score amenity, calculate rental return, predict appreciation or value a specific address, and it is not financial or property advice.",
    "growth-desc":
      "ACT suburbs appear here in descending order of their year-on-year median house-price change. The year-on-year change field is published for each suburb from Valuer-General-derived sales data, with ABS Census population used to require at least 200 residents. Rows without a positive latest median are omitted so missing price coverage cannot look like growth. The page shows the newest price period found in the Territory response, although the transactions represented can differ across suburbs. A higher median may result partly from a different mix of sold houses rather than equal appreciation across matched dwellings. For that reason, this is a ranking of published aggregate change, not a property-level performance table. It does not predict the next year, measure liquidity, assess value for money or recommend any Canberra suburb.",
    "growth-asc":
      "This Australian Capital Territory ranking sorts the lowest year-on-year suburb median house-price changes first. the suburb dataset supplies year-on-year change and Valuer-General-derived medians, while the ABS Census population field excludes Statistical Areas below 200 residents. A positive current median is also required, preventing absent price data from producing a false decline. The date displayed is the freshest property period in the Territory result, not confirmation that every suburb uses identical transactions or timing. Median changes are sensitive to which homes sold, and a shift toward smaller or older dwellings can lower the midpoint without applying uniformly to all addresses. The table is a retrospective description of reported suburb aggregates. It is not a repeat-sales index, market forecast, distress finding, individual appraisal or recommendation to transact.",
    affordability:
      "ACT suburbs are compared here using latest median house price divided by 52 times median weekly household income. Lower multiples rank first. Through the suburb dataset, the numerator is derived from Valuer-General records and the denominator and population come from the ABS Census. Every row needs positive price and income observations plus at least 200 residents, removing incomplete data and reducing noise from tiny Statistical Areas. The newest Territory price period is disclosed, but income retains a separate Census vintage. This ratio compares suburb medians; it does not model an actual Canberra household's capacity to buy. Deposits, mortgage rates, stamp duty, existing debts, household composition, property type and the dispersion of local incomes are absent. The ranking is neither a lending decision nor an assertion that a particular home is affordable or desirable.",
  },
};

function buildRanking(
  stateCode: StateCode,
  metric: RankingMetric,
): RankingDefinition {
  const stateName = STATE_NAMES[stateCode]!;
  const copy = METRIC_COPY[metric];
  const slug = `${copy.slugPrefix}-${stateCode.toLowerCase()}`;
  return {
    slug,
    stateCode,
    metric,
    title: `${copy.titlePrefix} in ${stateName} — House Price Rankings`,
    h1: `${copy.h1Prefix} in ${stateName}`,
    description: `${copy.descriptionLead} in ${stateName} — latest Valuer-General-derived medians plus ABS Census context, excluding missing prices and tiny areas.`,
    keywords: [
      `${copy.keywordLead} ${stateCode.toLowerCase()}`,
      `${copy.keywordLead} ${stateName.toLowerCase()}`,
      `${stateName.toLowerCase()} suburb house prices`,
      `house price rankings ${stateCode.toLowerCase()}`,
    ],
    dek: `${copy.dekLead} across ${stateName}, ranked from the latest available suburb data.`,
    blurb: BLURBS[stateCode][metric],
    related: METRIC_ORDER.filter((candidate) => candidate !== metric).map(
      (candidate) =>
        `${METRIC_COPY[candidate].slugPrefix}-${stateCode.toLowerCase()}`,
    ),
  };
}

// Only states with an ingested Valuer-General price feed get ranking pages.
// Every metric here — cheapest, dearest, growth, affordability — needs a median
// price, so a state without prices can only produce an empty page. Publishing
// those would advertise 25 soft-404s in the sitemap, which costs crawl budget
// and site-wide quality signals; a state we cannot rank is simply not offered.
//
// Measured against the production API on 2026-08-25 (suburbs with a non-zero
// median): NSW 2,433 · VIC 766 · SA 426 · QLD 0 · WA 0 · TAS 0 · NT 0 · ACT 0.
// The blurb table below already carries copy for all eight states, so enabling
// one is a single edit here once its feed lands — re-measure before doing it.
const RANKABLE_STATES: StateCode[] = ["NSW", "VIC", "SA"];

const definitions = RANKABLE_STATES.flatMap((stateCode) =>
  METRIC_ORDER.map((metric) => buildRanking(stateCode, metric)),
);

export const HOUSING_RANKINGS: Record<string, RankingDefinition> =
  Object.fromEntries(definitions.map((ranking) => [ranking.slug, ranking]));

export const HOUSING_RANKING_SLUGS = Object.keys(HOUSING_RANKINGS);

export function getHousingRanking(slug: string): RankingDefinition | undefined {
  return Object.hasOwn(HOUSING_RANKINGS, slug)
    ? HOUSING_RANKINGS[slug]
    : undefined;
}
