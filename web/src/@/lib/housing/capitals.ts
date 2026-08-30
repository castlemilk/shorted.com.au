/** Serializable content and ABS region mapping for /housing/capitals routes. */
export interface CapitalDefinition {
  slug: string;
  regionCode: string;
  name: string;
  stateCode: string;
  restOfStateCode: string | null;
  /** Metadata title without the site-name suffix supplied by the root layout. */
  title: string;
  h1: string;
  description: string;
  keywords: string[];
  dek: string;
  blurb: string;
}

export const CAPITALS: readonly CapitalDefinition[] = [
  {
    slug: "greater-sydney",
    regionCode: "1GSYD",
    name: "Greater Sydney",
    stateCode: "NSW",
    restOfStateCode: "1RNSW",
    title: "Greater Sydney Median House Price",
    h1: "Greater Sydney median house price",
    description:
      "Track Greater Sydney's median established-house transfer price, quarterly changes, unit spread and comparison with the rest of New South Wales since 2002.",
    keywords: [
      "Sydney median house price",
      "Greater Sydney house prices",
      "Sydney house price history",
      "Sydney house vs unit prices",
    ],
    dek: "Quarterly ABS transfer medians for established houses across Greater Sydney, set beside attached dwellings and the Rest of NSW.",
    blurb:
      "Greater Sydney’s series follows the median price recorded across settled transfers of established houses in the ABS Greater Capital City Statistical Area. It places the middle completed sale in each quarter at centre stage, so it is neither an average nor a measure of every dwelling. Sydney’s mix of harbour, inner, middle and outer markets can change between quarters; movement in the median may therefore reflect both prices and the homes that transferred. The observation is released quarterly, with the newest quarters marked preliminary when the ABS expects later revisions. Those flags are retained on this page and history may change after subsequent releases. This is not a feed of asking or listing prices, an automated valuation, a repeat-sales price index, or an estimate of what a particular property is worth. It is a descriptive record of established-house transfers, best read alongside the attached-dwelling and Rest of NSW series rather than as advice or a forecast.",
  },
  {
    slug: "greater-melbourne",
    regionCode: "2GMEL",
    name: "Greater Melbourne",
    stateCode: "VIC",
    restOfStateCode: "2RVIC",
    title: "Greater Melbourne Median House Price",
    h1: "Greater Melbourne median house price",
    description:
      "Explore Greater Melbourne's quarterly median established-house transfer price, house-unit gap and long-run comparison with the rest of Victoria.",
    keywords: [
      "Melbourne median house price",
      "Greater Melbourne house prices",
      "Melbourne property price history",
      "Melbourne house vs unit prices",
    ],
    dek: "A long-run view of Melbourne’s middle established-house transfer, with the attached-dwelling series and Rest of Victoria as context.",
    blurb:
      "For Greater Melbourne, each ABS quarterly observation is the median consideration among established-house transfers completed within the statistical capital region. Half of the included transfers sit above that figure and half below it; the result is not an average and does not track a fixed basket of homes. Changes in which parts of metropolitan Melbourne record transfers can shift the midpoint as well as changes in underlying sale prices. The ABS publishes the measure every quarter and labels recent observations preliminary while collection and processing are completed. Later releases can revise those quarters, so this page preserves the preliminary marker rather than presenting the latest number as final. The series is not a property listing monitor, a bank or automated valuation, a price index, or a forecast for Melbourne property. It describes settled established-house transfers. Comparing it with attached dwellings and Rest of Victoria helps show differences between broad market segments without valuing any individual home.",
  },
  {
    slug: "greater-brisbane",
    regionCode: "3GBRI",
    name: "Greater Brisbane",
    stateCode: "QLD",
    restOfStateCode: "3RQLD",
    title: "Greater Brisbane Median House Price",
    h1: "Greater Brisbane median house price",
    description:
      "See Greater Brisbane's median established-house transfer price since 2002, quarterly growth, unit spread and comparison with the rest of Queensland.",
    keywords: [
      "Brisbane median house price",
      "Greater Brisbane house prices",
      "Brisbane house price history",
      "Brisbane house and unit price gap",
    ],
    dek: "The ABS midpoint for Greater Brisbane’s established-house transfers, charted through two cycles and compared with attached dwellings and regional Queensland.",
    blurb:
      "Beginning in 2002, the Greater Brisbane history records the median value of established-house transfers settled during each quarter across the ABS capital-city statistical area. The median is the transaction in the middle after observed transfer values are ordered; it is not an average, total-market valuation or price index. A quarter with a different mix of locations, property sizes or transfer volumes may move the median even when no single Brisbane home follows the same path. Updates arrive quarterly. The newest observations can be preliminary and the ABS may revise them as more transfer information is incorporated, which is why the status appears beside the latest result here. This measure does not represent current property listings, advertised asking prices, appraisal or automated valuation estimates, and it does not predict the next quarter. It is evidence about completed established-house transfers. The attached-dwelling and Rest of Queensland lines provide useful segment and regional context without turning the series into advice.",
  },
  {
    slug: "greater-adelaide",
    regionCode: "4GADE",
    name: "Greater Adelaide",
    stateCode: "SA",
    restOfStateCode: "4RSAU",
    title: "Greater Adelaide Median House Price",
    h1: "Greater Adelaide median house price",
    description:
      "Follow Greater Adelaide's quarterly median established-house transfer price, house-versus-unit spread and comparison with the rest of South Australia.",
    keywords: [
      "Adelaide median house price",
      "Greater Adelaide house prices",
      "Adelaide house price history",
      "Adelaide house vs unit prices",
    ],
    dek: "Official quarterly transfer evidence for Greater Adelaide, with attached dwellings and the Rest of South Australia on the same scale.",
    blurb:
      "This Greater Adelaide measure answers a narrow question: what was the middle price among established-house transfers observed by the ABS in the quarter? It covers the Greater Capital City Statistical Area rather than a single council boundary, and it describes completed transfers rather than the stock of all Adelaide homes. Because the median depends on the properties changing hands, a shift in the composition of transfers can influence the result. It should not be read as an average or a pure price index. The series is updated quarterly. Recent data may carry a preliminary flag and can be revised in later ABS releases as reporting settles; the page shows that qualification with the observation. It is not based on real-estate listings or vendor asking prices, and it is not a valuation of a suburb, street or dwelling. Nor is it a projection. It is a historical established-house transfer statistic, complemented here by attached-dwelling and Rest of South Australia comparisons.",
  },
  {
    slug: "greater-perth",
    regionCode: "5GPER",
    name: "Greater Perth",
    stateCode: "WA",
    restOfStateCode: "5RWAU",
    title: "Greater Perth Median House Price",
    h1: "Greater Perth median house price",
    description:
      "Chart Greater Perth's median established-house transfer price by quarter, compare houses with units, and place the capital beside the rest of Western Australia.",
    keywords: [
      "Perth median house price",
      "Greater Perth house prices",
      "Perth house price history",
      "Perth house and unit prices",
    ],
    dek: "Greater Perth’s established-house transfer median across the full ABS history, with attached-dwelling and regional WA comparisons.",
    blurb:
      "Greater Perth’s line is built from the prices attached to established-house transfers in each ABS quarter. Sorting those completed transfers and selecting the midpoint produces the median: a robust summary of that quarter’s activity, but not the average value of Perth housing and not a constant-quality price index. The homes and locations represented can vary from one period to the next, so the chart documents an outcome without assigning a cause to it. ABS releases are quarterly and the latest observations may be preliminary. As additional records are processed, preliminary quarters can be revised; their status remains visible here so readers can distinguish them from settled history. The statistic is separate from live property listings, asking-price measures and modelled valuation products. It cannot value a particular house and it is not a market forecast. Read it as a long-run account of established-house transfers, with attached dwellings and Rest of Western Australia offering two deliberately different comparisons.",
  },
  {
    slug: "greater-hobart",
    regionCode: "6GHOB",
    name: "Greater Hobart",
    stateCode: "TAS",
    restOfStateCode: "6RTAS",
    title: "Greater Hobart Median House Price",
    h1: "Greater Hobart median house price",
    description:
      "Review Greater Hobart's quarterly median established-house transfer price, the house-unit difference and the capital's comparison with the rest of Tasmania.",
    keywords: [
      "Hobart median house price",
      "Greater Hobart house prices",
      "Hobart house price history",
      "Hobart house vs unit prices",
    ],
    dek: "A quarterly record of the middle established-house transfer across Greater Hobart, read against attached dwellings and the Rest of Tasmania.",
    blurb:
      "The Greater Hobart series summarises actual established-house transfers recorded for the ABS capital statistical region, one quarter at a time. Its value is the median transfer price—the middle observation once completed transfers are ranked—not an average across every property in Hobart. It also carries no information about the number or characteristics of homes that did not transfer. That matters because a different quarterly mix can alter the midpoint independently of any one dwelling’s experience. ABS publication follows a quarterly cadence. The most recent observations can be preliminary and are open to revision when later transfer records arrive, so their provisional status is surfaced on the page. This is not a collection of property listings, a measure of advertised expectations, a municipal valuation roll or an automated valuation estimate. It is also not a prediction. The chart is a historical account of established-house transfers; attached-dwelling and Rest of Tasmania series add comparison while retaining their separate geographic and dwelling definitions.",
  },
  {
    slug: "greater-darwin",
    regionCode: "7GDAR",
    name: "Greater Darwin",
    stateCode: "NT",
    restOfStateCode: "7RNTE",
    title: "Greater Darwin Median House Price",
    h1: "Greater Darwin median house price",
    description:
      "Track Greater Darwin's median established-house transfer price each quarter, including the unit spread and comparison with the rest of the Northern Territory.",
    keywords: [
      "Darwin median house price",
      "Greater Darwin house prices",
      "Darwin property price history",
      "Darwin house and unit prices",
    ],
    dek: "The middle established-house transfer in Greater Darwin each quarter, paired with attached dwellings and the Rest of NT without smoothing the history.",
    blurb:
      "In this chart, Greater Darwin is the ABS Greater Capital City Statistical Area and the price is the quarterly median of established-house transfers within it. The measure orders observed completed transfers and reports the middle value. It does not average the territory’s housing stock, adjust for the attributes of every home, or behave like a price index. Quarter-to-quarter movement can reflect which Darwin properties transferred as well as changes in their recorded prices, so the series should be interpreted as a broad transaction summary. New ABS observations may be labelled preliminary; later quarterly releases can revise them as the underlying transfer collection becomes more complete. This page exposes that preliminary status rather than smoothing or silently replacing it. The data do not come from property listings and are not asking prices, appraisal figures or a valuation for a particular address. They offer no forecast. They are a historical record of established-house transfers, with attached dwellings and Rest of Northern Territory shown as contextual comparisons.",
  },
  {
    slug: "australian-capital-territory",
    regionCode: "8ACTE",
    name: "Australian Capital Territory",
    stateCode: "ACT",
    restOfStateCode: null,
    title: "Australian Capital Territory Median House Price",
    h1: "Australian Capital Territory median house price",
    description:
      "Explore the ACT-wide quarterly median established-house transfer price, historical changes and the difference between established houses and attached dwellings.",
    keywords: [
      "ACT median house price",
      "Canberra house prices",
      "ACT house price history",
      "ACT house vs unit prices",
    ],
    dek: "A territory-wide ABS transfer median for established houses, compared with attached dwellings without inventing a rest-of-ACT region.",
    blurb:
      "The ABS region coded 8ACTE represents the Australian Capital Territory as a whole, not a Greater Canberra area split from a separate rest-of-territory market. Its quarterly figure is the median price among established-house transfers recorded across that territory-wide region. The midpoint describes completed transactions in the period; it is not an average home value and it does not hold the mix of transferred properties constant like a price index might. Each release adds a new quarter. The latest observations can be preliminary, and the ABS may revise them when further transfer information is processed, so this page keeps the preliminary status visible. The measure is unrelated to live property listings or advertised asking prices, and it is neither a statutory nor automated valuation of an ACT dwelling. It cannot forecast a later sale. It is evidence about historical established-house transfers. Attached dwellings provide a dwelling-type comparison, but there is deliberately no capital-versus-rest comparison because the ABS publishes no Rest of ACT counterpart.",
  },
];

export const CAPITAL_SLUGS = CAPITALS.map(({ slug }) => slug);

export function getCapital(slug: string): CapitalDefinition | undefined {
  return CAPITALS.find((capital) => capital.slug === slug);
}
