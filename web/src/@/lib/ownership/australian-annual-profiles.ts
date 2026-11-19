import type {
  AustralianInvestor,
  FilingIdentity,
  RegisterSnapshot,
} from "./australian-investors";

// Page numbers in links count PDF sheets. Page labels below follow the issuer’s pagination.
const reports = {
  FMG: {
    company: "Fortescue",
    date: "2026-08-17",
    url: "https://content.fortescue.com/fortescue17114-fortescueeb60-productionbbdb-8be5/media/project/fortescueportal/shared/documents/regulatory/asx-announcements/fy26-annual-report_-app4e_updated.pdf",
  },
  MIN: {
    company: "Mineral Resources",
    date: "2026-08-06",
    url: "https://cdn.sanity.io/files/o6ep64o3/production/b872ab24beb44ee4ea68c64c7cd431ea4ce49c74.pdf",
  },
  SGH: {
    company: "SGH",
    date: "2026-07-22",
    url: "https://announcements.asx.com.au/asxpdf/20260811/pdf/072m7w5dr14xl3.pdf",
  },
  MYR: {
    company: "Myer Holdings",
    date: "2026-09-24",
    url: "https://investor.myer.com.au/DownloadFile.axd?file=%2FReport%2FComNews%2F20261109%2F03159461.pdf",
  },
  PMV: {
    company: "Premier Investments",
    date: "2026-09-21",
    url: "https://www.premierinvestments.com.au/wp-content/uploads/2026/10/Premier-Investments-Limited-Annual-Report-FY26.pdf",
  },
  ARB: {
    company: "ARB Corporation",
    date: "2026-07-23",
    url: "https://cdn.financialreports.eu/financialreports/media/filings/64415/2026/RNS/64415_rns_2026-08-24_1a692773-0173-4456-9413-de1d051cf357.pdf",
  },
  KGN: {
    company: "Kogan.com",
    date: "2026-08-24",
    url: "https://www.marketindex.com.au/data-api/api/v1/announcements/XASX%3AKGN%3A3A702754/pdf/inline/2026-kogan-com-ltd-annual-report",
  },
  NWL: {
    company: "Netwealth Group",
    date: "2026-06-30",
    url: "https://cdn.financialreports.eu/financialreports/media/filings/65460/2026/RNS/65460_rns_2026-08-25_1b386da0-71a9-4a1e-bfb5-907c3758cbfc.pdf",
  },
  REH: {
    company: "Reece",
    date: "2026-08-04",
    url: "https://cdn.financialreports.eu/financialreports/media/filings/65683/2026/RNS/65683_rns_2026-08-23_071a5926-e8bf-46a6-8fbb-ff68f5e3ace7.pdf",
  },
  PWH: {
    company: "PWR Holdings",
    date: "2026-07-31",
    url: "https://www.marketindex.com.au/data-api/api/v1/announcements/XASX%3APWH%3A2A1690824/pdf/inline/annual-report-to-shareholders",
  },
  LOV: {
    company: "Lovisa Holdings",
    date: "2026-08-26",
    url: "https://www.marketindex.com.au/data-api/api/v1/announcements/XASX%3ALOV%3A3A704732/pdf/inline/annual-report-to-shareholders",
  },
  TPG: {
    company: "TPG Telecom",
    date: "2026-02-06",
    url: "https://www.marketindex.com.au/data-api/api/v1/announcements/XASX%3ATPG%3A2A1656646/pdf/inline/annual-report-to-shareholders",
  },
} as const;

type Code = keyof typeof reports;
function reportPage(code: Code, sheet: number) {
  return reports[code].url + "#page=" + sheet;
}

function interest(
  code: Code,
  filedName: string,
  page: number,
  sheet: number,
  amount: NonNullable<FilingIdentity["annualInterest"]>["amount"],
  aliases?: string[],
): FilingIdentity {
  const { company, date } = reports[code];
  return {
    code,
    filedName,
    source: reportPage(code, sheet),
    basis: "annual",
    annualInterest: { company, date, page, amount },
    ...(aliases && { aliases }),
  };
}

export const annualFilingProfiles: AustralianInvestor[] = [
  {
    slug: "andrew-and-nicola-forrest",
    name: "Andrew and Nicola Forrest",
    jointNames: ["John Andrew Henry Forrest", "Nicola Margaret Forrest"],
    description:
      "Fortescue lists Andrew and Nicola Forrest alongside Tattarang and Minderoo Foundation in one substantial holding. The figure covers all four parties.",
    filings: [
      interest(
        "FMG",
        "Tattarang Pty Ltd, Minderoo Foundation Limited, Nicola Margaret Forrest and John Andrew Henry Forrest",
        265,
        268,
        { shares: 1131365000, pct: 36.74 },
      ),
    ],
  },
  {
    slug: "chris-ellison",
    name: "Chris Ellison",
    description:
      "Mineral Resources identifies Ellison as a substantial holder. Its August register gives the percentage of capital and dates the last change to 11 May 2026.",
    filings: [interest("MIN", "CHRIS ELLISON", 326, 167, { pct: 10.54 })],
  },
  {
    slug: "kerry-stokes",
    name: "Kerry Stokes",
    description:
      "SGH reports Kerry Stokes with the North Aston, Wroxby, Tiberius and Australian Capital Equity entities. Its percentage uses the shares on issue on 22 July 2026.",
    filings: [
      interest(
        "SGH",
        "KM Stokes; North Aston Pty Limited, Wroxby Pty Limited, Tiberius (Seven Investments) Pty Limited and Ashblue Holdings Pty Limited; Tiberius Pty Limited, Redlake Pty Limited and Tiberius group entities; Australian Capital Equity Pty Limited, Clabon Pty Limited and Australian Capital Equity Pty Limited group entities",
        164,
        167,
        { shares: 207304349, pct: 50.93 },
      ),
    ],
  },
  {
    slug: "david-and-vicky-teoh",
    name: "David and Vicky Teoh",
    jointNames: ["David Teoh", "Vicky Teoh"],
    description:
      "TPG Telecom lists the Teohs and their associates together. The annual report repeats the share count and percentage from their substantial holder disclosure.",
    filings: [
      interest(
        "TPG",
        "David Teoh and Vicky Teoh and their associates",
        150,
        156,
        { shares: 264121325, pct: 14.21 },
      ),
    ],
  },
  {
    slug: "john-gay-wilson",
    name: "John Gay Wilson",
    description:
      "Reece lists John Gay Wilson in its substantial shareholder register. Reece says several of these interests cover the same shares.",
    filings: [
      interest("REH", "John Gay Wilson", 127, 128, { shares: 361013785 }),
    ],
  },
  {
    slug: "leslie-alan-wilson",
    name: "Leslie Alan Wilson",
    description:
      "Reece lists Leslie Alan Wilson in its substantial shareholder register. Reece says several of these interests cover the same shares.",
    filings: [
      interest("REH", "Leslie Alan Wilson", 127, 128, { shares: 357709180 }),
    ],
  },
  {
    slug: "bruce-walter-campbell-wilson",
    name: "Bruce Walter Campbell Wilson",
    description:
      "Reece lists Bruce Walter Campbell Wilson in its substantial shareholder register. Reece says several of these interests cover the same shares.",
    filings: [
      interest("REH", "Bruce Walter Campbell Wilson", 127, 128, {
        shares: 332665823,
      }),
    ],
  },
  {
    slug: "matthew-heine",
    name: "Matthew Heine",
    description:
      "Netwealth reports the ordinary shares in which Matthew Heine and his associates have a relevant interest. The figure includes associated holdings.",
    filings: [
      interest("NWL", "Matthew Heine", 130, 130, { shares: 103421775 }),
    ],
  },
  {
    slug: "nicholas-heine",
    name: "Nicholas Heine",
    description:
      "Netwealth reports the ordinary shares in which Nicholas Heine and his associates have a relevant interest. The figure includes associated holdings.",
    filings: [
      interest("NWL", "Nicholas Heine", 130, 130, { shares: 100086750 }, [
        "Nicholas St. Clair Max Heine",
      ]),
    ],
  },
  {
    slug: "michael-heine",
    name: "Michael Heine",
    description:
      "Netwealth reports the ordinary shares in which Michael Heine and his associates have a relevant interest. The figure includes associated holdings.",
    filings: [
      interest("NWL", "Michael Heine", 130, 130, { shares: 100040000 }),
    ],
  },
  {
    slug: "kees-weel",
    name: "Kees Weel",
    description:
      "PWR groups Kees Weel with the Lazy Weel and Wagon Weel trusts. Its top-20 register also identifies the Wagon Weel account.",
    filings: [
      interest(
        "PWH",
        "Kees Weel, Lazy Weel Pty Ltd ATF Lazy Weel Superannuation Fund Account and Wagon Weel Co Pty Ltd ATF Wagon Weel Trust",
        141,
        146,
        { shares: 10081385, pct: 10.02 },
      ),
    ],
  },
  {
    slug: "paul-weel",
    name: "Paul Weel",
    description:
      "PWR identifies KPW Property Holdings as acting for the KPW Holdings Trust and on behalf of Paul Weel.",
    filings: [
      interest(
        "PWH",
        "KPW Property Holdings Pty Ltd ATF KPW Holdings Trust on its own behalf and on behalf of Paul Weel",
        141,
        146,
        { shares: 6748427, pct: 6.71 },
      ),
    ],
  },
  {
    slug: "brett-blundy",
    name: "Brett Blundy",
    description:
      "Lovisa names BB Retail Capital and BBFit Investments in Blundy’s reported interest. The register lists the two companies separately.",
    filings: [
      interest(
        "LOV",
        "Brett Blundy and associated entities (“BBRC”)",
        115,
        116,
        { shares: 43802500 },
      ),
    ],
  },
  {
    slug: "ruslan-kogan",
    name: "Ruslan Kogan",
    description:
      "Kogan’s director disclosure names Kogan Management as trustee for the Ruslan Tech Trust. The annual register ranks that account first.",
    filings: [
      {
        code: "KGN",
        filedName: "Kogan Management Pty Ltd <The Ruslan Tech A/C>",
        basis: "annual",
        source:
          "https://www.marketindex.com.au/data-api/api/v1/announcements/XASX%3AKGN%3A3A705082/pdf/inline/change-of-director-s-interest-notice-rk#page=1",
        sourceLabel: "Ruslan Kogan’s director disclosure",
      },
    ],
  },
  {
    slug: "david-shafer",
    name: "David Shafer",
    description:
      "Shafer’s director disclosure identifies two parcels held through the Shafer Family Trust. Kogan.com lists each account separately.",
    filings: [
      {
        code: "KGN",
        filedName: "Shafer Corporation Pty Ltd <The Shafer Family A/C>",
        basis: "annual",
        source:
          "https://www.marketindex.com.au/data-api/api/v1/announcements/XASX%3AKGN%3A3A701484/pdf/inline/change-of-director-s-interest-notice-ds#page=1",
        sourceLabel: "David Shafer’s director disclosure",
      },
    ],
  },
];

// These reports order accounts without printing rank numbers. Kogan’s “twenty largest” table prints 21 accounts.
const orderedListSizes: Partial<Record<Code, number>> = {
  FMG: 20,
  SGH: 20,
  ARB: 20,
  KGN: 21,
  LOV: 20,
};

function register(
  code: Code,
  page: number,
  sheet: number,
  holders: RegisterSnapshot["holders"],
): RegisterSnapshot {
  const { company, date } = reports[code];
  return {
    code,
    company,
    date,
    page,
    source: reportPage(code, sheet),
    orderedListSize: orderedListSizes[code],
    holders,
  };
}

export const annualRegisters: RegisterSnapshot[] = [
  register("FMG", 265, 268, [
    {
      rank: 19,
      name: "Mr John William Cunningham",
      shares: 4000000,
      pct: 0.13,
      profile: "fmg-john-william-cunningham",
    },
  ]),
  register("SGH", 164, 167, [
    {
      rank: 1,
      name: "North Aston Pty Limited",
      shares: 137841807,
      pct: 33.87,
      profile: "kerry-stokes",
    },
    {
      rank: 2,
      name: "Ashblue Holdings Pty Limited",
      shares: 69462342,
      pct: 17.07,
      profile: "kerry-stokes",
    },
    {
      rank: 16,
      name: "Ryan Kerry Stokes",
      shares: 308174,
      pct: 0.08,
      profile: "ryan-stokes",
      profileName: "Ryan Stokes",
    },
    {
      rank: 18,
      name: "Mr Barry Martin Lambert",
      shares: 300000,
      pct: 0.07,
      profile: "sgh-barry-martin-lambert",
    },
  ]),
  register("MYR", 137, 139, [
    {
      rank: 10,
      name: "MS YUANYUAN ZHAO",
      shares: 9200000,
      pct: 0.53,
      profile: "myr-yuanyuan-zhao",
      profileName: "Yuanyuan Zhao",
    },
    {
      rank: 14,
      name: "MR YOUSSEF ELBAYEH",
      shares: 5330482,
      pct: 0.31,
      profile: "myr-youssef-elbayeh",
      profileName: "Youssef Elbayeh",
    },
    {
      rank: 16,
      name: "MR PAT O’NEILL",
      shares: 5000000,
      pct: 0.29,
      profile: "myr-pat-oneill",
      profileName: "Pat O’Neill",
    },
    {
      rank: 20,
      name: "MR RAYMOND JAMES ALLAN",
      shares: 4000000,
      pct: 0.23,
      profile: "myr-raymond-james-allan",
      profileName: "Raymond James Allan",
    },
  ]),
  register("PMV", 108, 121, [
    {
      rank: 12,
      name: "MR CON ZEMPILAS",
      shares: 470000,
      pct: 0.29,
      profile: "pmv-con-zempilas",
      profileName: "Con Zempilas",
    },
  ]),
  register("ARB", 72, 79, [
    {
      rank: 13,
      name: "Ms Judith Caroline Carpenter + Ms Gillian Clare Carpenter (Est Late P Carpenter A/C)",
      shares: 653831,
      pct: 0.78,
      profile: "arb-judith-and-gillian-carpenter",
      profileName: "Judith and Gillian Carpenter",
      jointNames: ["Judith Caroline Carpenter", "Gillian Clare Carpenter"],
    },
  ]),
  register("KGN", 94, 96, [
    {
      rank: 1,
      name: "KOGAN MANAGEMENT PTY LTD <THE RUSLAN TECH A/C>",
      shares: 15515701,
      pct: 16.37,
      profile: "ruslan-kogan",
    },
    {
      rank: 5,
      name: "SHAFER CORPORATION PTY LTD <THE SHAFER FAMILY A/C>",
      shares: 3075642,
      pct: 3.24,
      profile: "david-shafer",
    },
    {
      rank: 13,
      name: "SHAFER CORPORATION PTY LTD <SHAFER FAMILY A/C>",
      shares: 300000,
      pct: 0.32,
      profile: "david-shafer",
    },
    {
      rank: 14,
      name: "MR GORAN STEFKOVSKI",
      shares: 288384,
      pct: 0.3,
      profile: "kgn-goran-stefkovski",
      profileName: "Goran Stefkovski",
    },
    {
      rank: 17,
      name: "DR PHILIPPA JACQUELINE TAPLIN",
      shares: 260000,
      pct: 0.27,
      profile: "kgn-philippa-jacqueline-taplin",
      profileName: "Philippa Jacqueline Taplin",
    },
    {
      rank: 18,
      name: "MR OWEN FRANCIS EATON TAPLIN",
      shares: 260000,
      pct: 0.27,
      profile: "kgn-owen-francis-eaton-taplin",
      profileName: "Owen Francis Eaton Taplin",
    },
    {
      rank: 19,
      name: "MR ALI REZA KAMALI",
      shares: 230887,
      pct: 0.24,
      profile: "kgn-ali-reza-kamali",
      profileName: "Ali Reza Kamali",
    },
  ]),
  register("LOV", 116, 117, [
    {
      rank: 1,
      name: "BB RETAIL CAPITAL PTY LTD",
      shares: 43207500,
      pct: 39.02,
      profile: "brett-blundy",
    },
    {
      rank: 8,
      name: "MRS VANESSA LOUISE SPEER",
      shares: 927460,
      pct: 0.84,
      profile: "lov-vanessa-louise-speer",
      profileName: "Vanessa Louise Speer",
    },
    {
      rank: 12,
      name: "BBFIT INVESTMENTS PTE LTD",
      shares: 595000,
      pct: 0.54,
      profile: "brett-blundy",
    },
    {
      rank: 13,
      name: "MR VICTOR HERRERO AMIGO",
      shares: 500000,
      pct: 0.45,
      profile: "lov-victor-herrero-amigo",
      profileName: "Victor Herrero Amigo",
    },
  ]),
  register("PWH", 140, 145, [
    {
      rank: 3,
      name: "WAGON WEEL CO PTY LTD <WAGON WEEL A/C>",
      shares: 10000000,
      pct: 9.94,
      profile: "kees-weel",
    },
    {
      rank: 5,
      name: "KPW PROPERTY HOLDINGS PTY LTD <KPW HOLDINGS A/C>",
      shares: 6748427,
      pct: 6.71,
      profile: "paul-weel",
    },
    {
      rank: 20,
      name: "MS DESLEA MARY SNEDDON",
      shares: 128000,
      pct: 0.13,
      profile: "pwh-deslea-mary-sneddon",
      profileName: "Deslea Mary Sneddon",
    },
  ]),
];
