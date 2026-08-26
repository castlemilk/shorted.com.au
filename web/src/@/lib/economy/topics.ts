/**
 * Serializable registry for /economy/[state]/[topic].
 *
 * The records in this file are shared by server pages and the core sitemap.
 * Keep definition values as plain data: no formatter, scale, component or
 * generated protobuf instance belongs in the registry.
 */
import {
  STATE_NAMES,
  STATE_SLUGS,
  type StateSlug,
} from "@/lib/economy/map-metrics";

export const ECONOMY_TOPIC_SLUGS = [
  "approvals",
  "business",
  "construction",
  "gdp",
  "labour",
  "lending",
  "population",
  "spending",
  "wages",
] as const;

export type EconomyTopicSlug = (typeof ECONOMY_TOPIC_SLUGS)[number];

export interface EconomyTopicDefinition {
  topic: EconomyTopicSlug;
  slug: EconomyTopicSlug;
  name: string;
  titleTemplate: string;
  h1Template: string;
  descriptionTemplate: string;
  keywordTemplates: string[];
  explainer: string;
  seriesCountByState: Record<StateSlug, number>;
  ledes: Partial<Record<StateSlug, string>>;
}

export interface PublishedEconomyTopicPair {
  state: StateSlug;
  topic: EconomyTopicSlug;
}

/**
 * Publication requires a useful family, not a one-chart thin page. Production
 * was measured on 2026-08-26: ACT and NT each had only one labour series because
 * the ABS does not publish their seasonally-adjusted state labour family.
 */
export const MIN_ECONOMY_TOPIC_SERIES = 2;

const uniformSeriesCounts = (count: number): Record<StateSlug, number> =>
  Object.fromEntries(STATE_SLUGS.map((state) => [state, count])) as Record<
    StateSlug,
    number
  >;

const labourSeriesCounts: Record<StateSlug, number> = {
  nsw: 4,
  vic: 4,
  qld: 4,
  sa: 4,
  wa: 4,
  tas: 4,
  nt: 1,
  act: 1,
};

export const ECONOMY_TOPICS: Record<
  EconomyTopicSlug,
  EconomyTopicDefinition
> = {
  approvals: {
    topic: "approvals",
    slug: "approvals",
    name: "Building approvals",
    titleTemplate: "{state} Building Approvals — Dwelling Data",
    h1Template: "{state} building approvals",
    descriptionTemplate:
      "Track {state} building approvals, including dwelling totals and population-adjusted measures, with latest ABS values, changes and history.",
    keywordTemplates: [
      "{stateLower} building approvals",
      "building approvals {stateSlug}",
      "{stateLower} dwelling approvals",
      "abs building approvals {stateLower}",
    ],
    explainer:
      "Building approvals count dwellings authorised through state and territory approval systems before construction begins. The Australian Bureau of Statistics publishes the Building Approvals collection each month, drawing on permits reported by councils and other approving authorities. This topic keeps the available original state total and population-adjusted series together, so the headline count can be read beside a measure that is more comparable across differently sized jurisdictions. Monthly figures can move sharply when a large apartment project is approved. Recent periods may also be revised when authorities submit late records, classifications change, an approval is amended or updated population estimates affect the derived rate. An approval is an administrative decision, not proof that work has started, finance has settled or a completed home will reach the market. It is therefore neither a construction-completions measure nor a forecast of housing supply, prices or investment returns.",
    seriesCountByState: uniformSeriesCounts(2),
    ledes: {
      nsw: "New South Wales approvals combine Australia's largest dwelling pipeline with substantial month-to-month project effects. Read the total beside the population-adjusted series to separate scale from approval intensity.",
      vic: "Victoria's building approvals can be reshaped by a small number of multi-unit developments, especially around Melbourne. The paired series show both the raw dwelling count and its rate relative to population.",
      qld: "Queensland's approval data spans fast-growing metropolitan and regional markets, so the statewide total carries a broad geographic mix. Its per-capita companion helps put that volume into demographic context.",
      sa: "In South Australia, individual apartment or land-release decisions can make a monthly approvals result unusually uneven. Viewing both published measures makes those changes easier to distinguish from the state's underlying scale.",
      wa: "Western Australia's dwelling pipeline is summarised here before any approved project necessarily breaks ground. The count answers how many homes were authorised, while the adjusted measure supports a fairer interstate reading.",
      tas: "Tasmanian approval totals are smaller and can be especially sensitive to one sizeable development. Pairing the level with the population-based rate keeps a single monthly number from carrying the whole interpretation.",
      nt: "Northern Territory approvals cover a compact market where a limited number of projects can dominate the latest period. The two-series view preserves the reported volume while showing how it compares with the Territory's population.",
      act: "Canberra's approvals series reflects decisions within a geographically concentrated housing market. Looking across both the dwelling count and population-adjusted measure reveals more than either headline can on its own.",
    },
  },
  business: {
    topic: "business",
    slug: "business",
    name: "Business indicators",
    titleTemplate: "{state} Business Indicators — Latest Data",
    h1Template: "{state} business indicators",
    descriptionTemplate:
      "Explore {state} business indicators from official data, with the latest values, prior-period changes, source details and full series histories.",
    keywordTemplates: [
      "{stateLower} business indicators",
      "business data {stateSlug}",
      "{stateLower} business conditions data",
      "abs business indicators {stateLower}",
    ],
    explainer:
      "Business indicators describe selected parts of firms' recorded activity rather than a single measure of business health. The Australian Bureau of Statistics publishes the underlying business collections, generally on a quarterly timetable, using survey and administrative inputs that are aggregated for each jurisdiction. This page keeps the two available state series together and prints each series' own unit, frequency and adjustment because the measures should not be assumed to be interchangeable. Initial estimates can be revised when businesses provide updated returns, administrative records are refreshed, seasonal patterns are recalculated or benchmark information becomes available. Movements may also reflect industry composition and the concentration of large employers within a state. These indicators do not directly measure every small business, profitability for a particular company, confidence, insolvency risk or the value of listed shares. They describe published historical aggregates and are not a forecast, investment signal or assessment of an individual firm's prospects.",
    seriesCountByState: uniformSeriesCounts(2),
    ledes: {
      nsw: "New South Wales has the country's broadest mix of corporate and small-business activity, which can pull its two indicators in different directions. This page keeps both official series visible rather than reducing that mix to one headline.",
      vic: "Victoria's business readings reflect a service-heavy capital alongside manufacturing and regional industries. Comparing the pair helps show whether the latest movement is shared across the available measures or confined to one.",
      qld: "Queensland business activity is exposed to population growth, tourism, resources and construction at the same time. The two published series provide separate lenses on that changing state-wide base.",
      sa: "South Australia's business indicators sit across advanced manufacturing, services, agriculture and defence-related activity. Their histories make it possible to see whether a current reading is unusual for either measure.",
      wa: "Western Australian firms operate within an economy strongly influenced by resources but not defined by them alone. Reading the available business series together preserves that distinction and their separate units.",
      tas: "Tasmania's smaller business base means large industry or seasonal shifts can be conspicuous in aggregate data. The paired indicators offer useful context on whether a move appears in more than one published measure.",
      nt: "Northern Territory business aggregates can be affected by a relatively small number of employers and projects. Showing the complete two-series family makes that concentration visible instead of presenting a solitary result.",
      act: "The Australian Capital Territory's business profile is closely connected to public-sector demand while still containing a diverse private economy. These two series track different dimensions of that activity over time.",
    },
  },
  construction: {
    topic: "construction",
    slug: "construction",
    name: "Construction work",
    titleTemplate: "{state} Construction Work Done — ABS Data",
    h1Template: "{state} construction work done",
    descriptionTemplate:
      "Follow {state} construction work done across the full available ABS series family, with latest levels, quarterly changes and historical charts.",
    keywordTemplates: [
      "{stateLower} construction work done",
      "construction data {stateSlug}",
      "{stateLower} construction activity",
      "abs construction {stateLower}",
    ],
    explainer:
      "Construction work done estimates the value of building and engineering activity completed during a period, regardless of when a project was approved or will finish. The Australian Bureau of Statistics publishes the state and territory estimates quarterly from its construction activity collections. The three series on these pages keep the available components together, with their own units and adjustment status, because residential building, non-residential work and engineering activity can follow different paths. Current-quarter estimates may be revised as survey responses arrive, project values are updated and seasonal factors are re-estimated; larger national-accounts benchmarking revisions can also alter history. Values can be expressed in current prices or volume terms, so the unit shown beside each chart matters. Work done is not the number of workers, the count of projects, an approval pipeline or company revenue. It records estimated completed activity and does not predict future construction, property supply or listed-company performance.",
    seriesCountByState: uniformSeriesCounts(3),
    ledes: {
      nsw: "New South Wales construction combines major transport works, commercial building and a large residential sector. The three component histories show which part of that broad workload is shaping the latest state result.",
      vic: "Victoria's construction cycle is spread across housing, business premises and engineering projects. Keeping all three official series together avoids treating one category's rise or fall as the whole state story.",
      qld: "Queensland construction activity stretches from south-east housing to regional infrastructure and resources work. The component view helps locate the latest change within that unusually wide project mix.",
      sa: "South Australian work done can shift as defence, infrastructure and building programs move between stages. These histories separate the available construction components and retain the revisions published for each.",
      wa: "Western Australia's engineering workload can be large beside its building sectors because of resources and infrastructure projects. The full family makes those differing scales explicit while preserving each quarterly path.",
      tas: "Tasmania's construction totals can respond visibly when a major project enters or leaves active work. Looking across three series shows whether the movement is concentrated or shared with building activity.",
      nt: "Northern Territory construction is a small, project-led market where one engineering program may materially change a quarter. The complete component set provides the context needed to recognise that concentration.",
      act: "ACT construction is dominated by an urban market but still spans residential, commercial and engineering work. The three official measures reveal how those parts contribute across successive quarters.",
    },
  },
  gdp: {
    topic: "gdp",
    slug: "gdp",
    name: "State final demand",
    titleTemplate: "{state} State Final Demand — Quarterly ABS Data",
    h1Template: "{state} state final demand",
    descriptionTemplate:
      "Track {state} state final demand, the ABS quarterly proxy for domestic state activity, with total and per-capita series, changes and history.",
    keywordTemplates: [
      "{stateLower} state final demand",
      "sfd {stateSlug}",
      "{stateLower} economic activity",
      "abs state final demand {stateLower}",
    ],
    explainer:
      "State final demand measures spending within a state or territory by households, governments and businesses, including investment, but excluding international and interstate trade. The Australian Bureau of Statistics publishes it quarterly in the Australian National Accounts, with chain-volume estimates designed to show changes after removing direct price effects. This topic brings the total and per-capita state series together. State final demand is a proxy for domestic state activity, not a state-level gross domestic product flow: the ABS does not publish a quarterly state GDP flow. It can rise while export-facing production weakens, or fall while net exports support broader output. National-accounts estimates are revised as source data improves, seasonal factors are re-estimated and annual supply-use or state accounts benchmarks are incorporated. Per-capita results also depend on population estimates. The series describe recorded demand; they are not a measure of household welfare, a forecast or advice about markets or policy.",
    seriesCountByState: uniformSeriesCounts(2),
    ledes: {
      nsw: "New South Wales state final demand captures spending and investment inside the country's largest state economy while leaving trade outside the measure. The total and per-person series distinguish aggregate scale from demand relative to population.",
      vic: "Victoria's quarterly demand path reflects household, government and business spending within the state boundary. Reading its level alongside the per-capita measure shows whether population growth is changing the interpretation.",
      qld: "Queensland state final demand covers domestic expenditure but not the export flows important to its resources economy. The two charts therefore describe internal demand at both whole-state and per-person scale.",
      sa: "South Australia's state final demand series provides a quarterly view of expenditure occurring within the state. Its per-capita counterpart adds context when aggregate growth and population change do not move together.",
      wa: "Western Australian state final demand deliberately excludes the trade balance, so it should be read separately from export-led production. These paired measures track internal spending in total and for each resident.",
      tas: "Tasmania's domestic demand can look different once changes in population are accounted for. The complete two-series view places the chain-volume total beside its per-capita equivalent without treating either as total output.",
      nt: "Northern Territory state final demand can be volatile when major investment programs change phase. Comparing the aggregate with the per-person series helps expose both project scale and the Territory's small population base.",
      act: "ACT state final demand is closely shaped by household and government expenditure in Canberra. The total records the jurisdiction-wide level, while the per-capita history offers a second view of the same domestic demand base.",
    },
  },
  labour: {
    topic: "labour",
    slug: "labour",
    name: "Labour market",
    titleTemplate: "{state} Unemployment Rate and Labour Market",
    h1Template: "{state} unemployment and labour market",
    descriptionTemplate:
      "See the {state} unemployment rate, employment, participation and job vacancies, with adjustment, frequency, latest ABS readings and history.",
    keywordTemplates: [
      "{stateLower} unemployment rate",
      "unemployment rate {stateSlug}",
      "{stateLower} labour market",
      "abs labour force {stateLower}",
    ],
    explainer:
      "Labour Force statistics estimate how many people are employed, unemployed and participating in the labour market, using the Australian Bureau of Statistics monthly household survey. A person is unemployed only when they are without work, available to start and actively looking; the unemployment rate divides that estimate by the labour force, not by the whole population. Each published drill-down combines three monthly seasonally adjusted Labour Force measures with quarterly original job vacancies from the separate ABS Job Vacancies survey, and the page labels those differences explicitly. Survey estimates carry sampling error and can move as population benchmarks, seasonal factors and incoming responses are revised. Monthly changes can be noisy even when rounded rates look precise. Employment counts people rather than jobs, participation does not measure hours or pay, and vacancies are unfilled jobs rather than hiring. These historical estimates do not forecast recessions, wages or an individual's employment prospects.",
    seriesCountByState: labourSeriesCounts,
    ledes: {
      nsw: "New South Wales labour data covers the country's largest workforce and can still move unevenly from month to month. Three seasonally adjusted monthly measures sit beside original quarterly vacancies, preserving both the unemployment context and the different collection cadence.",
      vic: "Victoria's unemployment headline is one part of a larger monthly labour picture. Seasonally adjusted employment and participation estimates surround that rate, while the original vacancies series adds a separate quarterly view of unmet demand.",
      qld: "Queensland's expanding and geographically dispersed workforce can produce different signals across labour measures. The three seasonally adjusted monthly histories show unemployment, participation and employment, with original quarterly vacancies clearly identified alongside them.",
      sa: "South Australia's monthly Labour Force estimates are survey-based, so a single rounded rate should be read with companion measures. Seasonally adjusted workforce series provide that context, and original job vacancies contribute a distinct quarterly signal.",
      wa: "Western Australia's labour market is influenced by both metropolitan services and project-based regional employment. Its seasonally adjusted monthly measures reveal the broader workforce picture, while original quarterly vacancies track unfilled jobs on their own schedule.",
      tas: "Tasmania's smaller survey sample can make month-to-month labour estimates comparatively variable. Keeping three seasonally adjusted measures with the separately labelled original vacancies series helps distinguish an isolated rate movement from wider labour change.",
    },
  },
  lending: {
    topic: "lending",
    slug: "lending",
    name: "Lending indicators",
    titleTemplate: "{state} Lending Indicators — Latest ABS Data",
    h1Template: "{state} lending indicators",
    descriptionTemplate:
      "Compare {state} lending indicators across the full available ABS series family, including latest commitments, monthly changes and history.",
    keywordTemplates: [
      "{stateLower} lending indicators",
      "home lending {stateSlug}",
      "{stateLower} loan commitments",
      "abs lending {stateLower}",
    ],
    explainer:
      "Lending indicators record new housing-finance commitments reported by banks and other lenders during a period. The Australian Bureau of Statistics publishes these state series quarterly from lender-supplied administrative data, with state attribution based on the information attached to each commitment. The two series keep owner-occupier and investor lending side by side so a change in one borrower group is not mistaken for a change across all finance. Figures can be revised when lenders correct or reclassify submissions and when seasonal adjustment is updated; unusually large commitments or policy deadlines can also affect a quarter. A commitment is not necessarily cash already advanced, and these flows are different from the outstanding stock of credit, mortgage balances, applications that never proceed or property transaction counts. Values do not describe loan quality, affordability or future arrears. They are historical aggregates, not a forecast of housing prices, interest rates or lender and borrower outcomes.",
    seriesCountByState: uniformSeriesCounts(2),
    ledes: {
      nsw: "New South Wales accounts for a large share of Australian housing finance, but borrower categories need not move together. The two commitment series show where the latest quarterly change sits within that split.",
      vic: "Victoria's lending flows can respond to transaction volumes and refinancing conditions without describing all outstanding mortgages. Comparing both available categories provides a clearer view of new commitments in the state.",
      qld: "Queensland lending combines established markets with strong population-linked housing demand. The paired quarterly histories help show whether finance movement is concentrated in one part of the borrower mix.",
      sa: "South Australian loan commitments are presented here as flows agreed during each quarter, not the stock of debt. Two separate series retain the category detail behind the latest state total.",
      wa: "Western Australia's lending cycle can diverge from eastern-state patterns as local housing and employment conditions change. These companion series trace how the available commitment categories contribute over time.",
      tas: "Tasmania's smaller lending market can make individual quarters appear pronounced in percentage terms. Seeing both published series helps place that movement against the level and category responsible.",
      nt: "Northern Territory finance volumes are compact enough for a limited number of commitments to affect the quarterly result. The two-series history makes those shifts visible without treating commitments as completed property sales.",
      act: "ACT lending data reflects a concentrated urban property market and its changing borrower mix. Comparing the available commitment series shows whether the latest result is broad or category-specific.",
    },
  },
  population: {
    topic: "population",
    slug: "population",
    name: "Population growth",
    titleTemplate: "{state} Population Growth — ERP and Components",
    h1Template: "{state} population growth",
    descriptionTemplate:
      "Track {state} population growth through estimated resident population and its components, with latest ABS values, changes and full histories.",
    keywordTemplates: [
      "{stateLower} population growth",
      "population growth {stateSlug}",
      "{stateLower} estimated resident population",
      "abs population {stateLower}",
    ],
    explainer:
      "Estimated resident population is the Australian Bureau of Statistics' official measure of people who usually live in each state or territory. Quarterly updates start from the Census population base and add natural increase, net overseas migration and net interstate migration, which are shown as the wider four-series family on these pages. The newest estimates are preliminary because births, deaths and migration records arrive on different schedules. They are revised as registration data matures, traveller and administrative information is updated, and after each Census through rebasing and intercensal adjustments. Component estimates may therefore change even when the broad population direction does not. Estimated resident population is not a live headcount, a count of citizens, a measure of housing demand or a statement about infrastructure capacity. Migration components are net flows, so they conceal larger movements in both directions. The series describe past demographic change and do not forecast future population, rents, employment or public-service needs.",
    seriesCountByState: uniformSeriesCounts(4),
    ledes: {
      nsw: "New South Wales population change combines natural increase with large overseas and interstate migration flows. The four component series show which part of that demographic equation is driving the latest estimate.",
      vic: "Victoria's resident population has historically been sensitive to both overseas arrivals and movements across state borders. This full family separates those flows from natural increase and the resulting population level.",
      qld: "Queensland population growth is often discussed through interstate migration, but that is only one component. The four histories place it beside overseas migration, natural increase and total estimated residents.",
      sa: "South Australia's demographic path reflects a changing balance between births, deaths and migration. Keeping each component visible makes clear how the latest population estimate was assembled.",
      wa: "Western Australian population growth can respond to labour demand through movements from overseas and other states. These component series show those net flows alongside natural increase and the resident total.",
      tas: "Tasmania's population movements are modest in absolute terms, making shifts in interstate migration especially noticeable. The four-series view anchors those flows to natural change and the overall estimate.",
      nt: "Northern Territory population estimates can change materially with comparatively small interstate or overseas flows. Breaking the total into its components reveals why a quarterly headline moved.",
      act: "Canberra's population path combines a young demographic profile with interstate and international mobility. The component histories explain how those forces feed into the ACT estimated resident population.",
    },
  },
  spending: {
    topic: "spending",
    slug: "spending",
    name: "Household spending",
    titleTemplate: "{state} Household Spending — Monthly Indicators",
    h1Template: "{state} household spending",
    descriptionTemplate:
      "Follow {state} household spending across total, per-capita and growth measures, with latest ABS readings, monthly changes and history.",
    keywordTemplates: [
      "{stateLower} household spending",
      "consumer spending {stateSlug}",
      "{stateLower} spending growth",
      "abs household spending {stateLower}",
    ],
    explainer:
      "The Monthly Household Spending Indicator estimates household expenditure using aggregated bank transactions and other administrative data assembled by the Australian Bureau of Statistics. State results are published monthly, and this topic groups the total, per-capita and annual-growth views so users can separate scale, population effects and rate of change. Coverage and methods differ from both Retail Trade and the quarterly household consumption measure in the National Accounts. The indicator includes selected services as well as goods, but it does not capture every payment method or every category of household outlay. Recent observations can be revised when data providers refresh transactions, classifications are refined, seasonal factors change or updated population estimates affect per-capita values. Nominal spending can also rise because prices increased rather than households bought more. These series describe recorded expenditure patterns; they do not measure wellbeing, savings, debt stress or future consumer demand, and they are not a forecast or financial advice.",
    seriesCountByState: uniformSeriesCounts(3),
    ledes: {
      nsw: "New South Wales household spending reflects both a large population and substantial differences across goods and services. Total, per-capita and growth series provide three distinct ways to read the latest monthly result.",
      vic: "Victoria's spending level can rise with population even when expenditure per resident follows a different path. The three-series family keeps that distinction alongside the published annual change.",
      qld: "Queensland household expenditure is shaped by population growth and a geographically varied consumer base. Comparing the level, per-person measure and growth rate shows which force is most visible in the latest data.",
      sa: "South Australian spending is presented here in aggregate and after accounting for population size. Its growth series adds a historical rate of change without turning the indicator into a volume measure.",
      wa: "Western Australian household spending can move with incomes, prices and population at different speeds. These three official views separate the total dollars, per-capita result and annual movement.",
      tas: "Tasmania's smaller expenditure base means monthly changes can look prominent even when the dollar movement is limited nationally. The per-capita and growth companions provide scale and direction around that total.",
      nt: "Northern Territory spending combines a small population with distinctive geography and household costs. Showing all three measures prevents its aggregate level from being compared with larger states without context.",
      act: "ACT household expenditure occurs within a high-income, compact jurisdiction whose total is small nationally. The level, per-person and growth histories show how those characteristics affect different readings.",
    },
  },
  wages: {
    topic: "wages",
    slug: "wages",
    name: "Wage growth",
    titleTemplate: "{state} Wage Growth — Wage Price Index Data",
    h1Template: "{state} wage growth",
    descriptionTemplate:
      "Track {state} wage growth through the full Wage Price Index series family, with latest ABS values, quarterly changes, metadata and history.",
    keywordTemplates: [
      "{stateLower} wage growth",
      "wage growth {stateSlug}",
      "{stateLower} wage price index",
      "abs wages {stateLower}",
    ],
    explainer:
      "The Wage Price Index measures changes in the price employers pay for a fixed basket of jobs, holding job quality and quantity as constant as practical. The Australian Bureau of Statistics publishes it quarterly from a survey of employee jobs, with state series covering the index, annual growth and a derived real annual growth measure. These state series are original and not seasonally adjusted, a status printed beside every chart. The employee-job sample and expenditure weights are periodically updated, while published history can change if the ABS corrects source data or methods and if the derived real measure receives revised inflation inputs. The index is designed to remove compositional shifts, so it is not average earnings, household income, take-home pay or the wage received by a typical worker. It excludes changes caused solely by workers moving between differently paid jobs. These historical price measures do not forecast inflation, employment, interest rates or an individual's next pay decision.",
    seriesCountByState: uniformSeriesCounts(3),
    ledes: {
      nsw: "New South Wales wage growth spans a large and diverse employee-job market. The index level and its quarterly and annual changes show the same price movement at three useful horizons.",
      vic: "Victoria's Wage Price Index controls for changes in the mix of jobs rather than tracking average pay packets. Its three published series reveal both the latest pace and the longer index path.",
      qld: "Queensland wages cover industries ranging from tourism and services to construction and resources. Reading the index with both growth measures shows how the latest quarter fits into the broader state trajectory.",
      sa: "South Australian wage movements are summarised for a fixed basket of employee jobs. The full series family separates the index level from short-term and year-ended percentage change.",
      wa: "Western Australia's occupational and industry mix can shift with resource cycles, which is why the fixed-job design matters. These three histories show wage-price change without treating workforce composition as wage growth.",
      tas: "Tasmania's Wage Price Index estimates can be read across the level, quarterly movement and annual pace. Together they provide more context than a single rounded growth figure in a smaller labour market.",
      nt: "Northern Territory wage data covers a compact and distinctive employee-job market. The index and two growth rates show whether a quarterly movement is also visible over the year.",
      act: "ACT wage growth reflects a labour market with a substantial public-sector presence but is not a measure of government pay alone. All three Wage Price Index series preserve the level and both change horizons.",
    },
  },
};

export const PUBLISHED_ECONOMY_TOPIC_PAIRS: PublishedEconomyTopicPair[] =
  STATE_SLUGS.flatMap((state) =>
    ECONOMY_TOPIC_SLUGS.filter(
      (topic) =>
        ECONOMY_TOPICS[topic].seriesCountByState[state] >=
        MIN_ECONOMY_TOPIC_SERIES,
    ).map((topic) => ({ state, topic })),
  );

export function getEconomyTopic(
  slug: string,
): EconomyTopicDefinition | undefined {
  return Object.hasOwn(ECONOMY_TOPICS, slug)
    ? ECONOMY_TOPICS[slug as EconomyTopicSlug]
    : undefined;
}

export function isPublishedEconomyTopic(
  state: StateSlug,
  topic: EconomyTopicSlug,
): boolean {
  return (
    ECONOMY_TOPICS[topic].seriesCountByState[state] >=
    MIN_ECONOMY_TOPIC_SERIES
  );
}

function resolveStateTemplate(template: string, state: StateSlug): string {
  const name = STATE_NAMES[state];
  return template
    .replaceAll("{stateLower}", name.toLowerCase())
    .replaceAll("{stateSlug}", state)
    .replaceAll("{state}", name);
}

export function economyTopicCopyForState(
  definition: EconomyTopicDefinition,
  state: StateSlug,
) {
  return {
    title: resolveStateTemplate(definition.titleTemplate, state),
    h1: resolveStateTemplate(definition.h1Template, state),
    description: resolveStateTemplate(definition.descriptionTemplate, state),
    keywords: definition.keywordTemplates.map((keyword) =>
      resolveStateTemplate(keyword, state),
    ),
    lede: definition.ledes[state],
  };
}
