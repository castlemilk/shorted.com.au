import {
  annualFilingProfiles,
  annualRegisters,
} from "./australian-annual-profiles";
import { noticeProfiles } from "./australian-notice-profiles";

/** An ASX issuer and a filing together establish an identity. A surname, fund
 * manager or custodian is never evidence for a cross-issuer link. */
export const AUSTRALIAN_INVESTORS_PATH = "/ownership/traders/australia";

export type FilingIdentity = {
  code: string;
  filedName: string;
  source: string;
  basis?: "annual";
  sourceLabel?: string;
  annualInterest?: {
    company: string;
    date: string;
    page: number;
    amount: { shares: number; pct?: number } | { pct: number; shares?: number };
  };
  notice?: {
    company: string;
    date: string;
    announcementId: string;
  } & ({ form: "603" | "604"; pct: number } | { form: "605"; pct: null });
  aliases?: string[];
};

export type AustralianInvestor = {
  slug: string;
  name: string;
  description: string;
  alternateName?: string;
  filings: FilingIdentity[];
  jointNames?: readonly [string, string];
};

export const announcementUrl = (id: string) =>
  `https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=${id}`;

const asxFiling = (
  code: string,
  filedName: string,
  id: string,
): FilingIdentity => ({
  code,
  filedName,
  source: announcementUrl(id),
});

const filingProfiles: AustralianInvestor[] = [
  {
    slug: "gina-rinehart",
    name: "Gina Rinehart",
    alternateName: "Georgina Hope Rinehart",
    description:
      "Georgina Hope Rinehart and Hancock Prospecting report these voting interests together.",
    filings: [
      asxFiling(
        "WCN",
        "Mrs Georgina Hope Rinehart, Hancock Prospecting Pty Ltd",
        "03157441",
      ),
      asxFiling(
        "BM1",
        "Mrs Georgina Hope Rinehart, Hancock Prospecting Pty Ltd",
        "03154868",
      ),
    ],
  },
  {
    slug: "gerald-harvey",
    name: "Gerry Harvey",
    alternateName: "Gerald Harvey",
    description:
      "Harvey Norman names Gerald Harvey on its share register. His substantial holding notice includes the associates in its annexure.",
    filings: [
      asxFiling(
        "HVN",
        "GERALD HARVEY and the persons listed in Annexure 2",
        "02856133",
      ),
    ],
  },
  {
    slug: "wesley-and-emma-maas",
    name: "Wesley and Emma Maas",
    jointNames: ["Wesley Jon Maas", "Emma Margaret Maas"],
    description:
      "Wesley Jon Maas and Emma Margaret Maas file jointly. Their annual register entries identify each registered shareholder separately.",
    filings: [
      asxFiling("MGH", "Wesley Jon Maas and Emma Margaret Maas", "03153538"),
    ],
  },
  {
    slug: "richard-white",
    name: "Richard White",
    description:
      "WiseTech Global identifies Richard White as the owner of RealWise Holdings. The annual register lists the company's entries separately.",
    filings: [
      asxFiling("WTC", "Richard White, RealWise Holdings Pty Ltd", "02994911"),
    ],
  },
  {
    slug: "david-dominic-pevcic",
    name: "David Dominic Pevcic",
    description:
      "The AdAlta and Reedy Lagoon notices both identify David Dominic Pevcic by his full name.",
    filings: [
      asxFiling("1AD", "David Dominic Pevcic", "03040108"),
      asxFiling("RLC", "MR DAVID DOMINIC PEVCIC", "03162070"),
    ],
  },
  ...noticeProfiles,
  ...annualFilingProfiles,
  {
    slug: "sam-hupert",
    name: "Sam Hupert",
    alternateName: "Sam Aaron Hupert",
    description:
      "Pro Medicus groups several shareholdings under Dr S Hupert in its annual report.",
    filings: [
      {
        code: "PME",
        filedName: "Dr S Hupert (multiple shareholdings)",
        aliases: ["Dr Sam Aaron Hupert", "Sam Aaron Hupert", "Sam Hupert"],
        basis: "annual",
        sourceLabel: "Pro Medicus board biography",
        source:
          "https://www.promed.com.au/about/board/#:~:text=Dr%20Sam%20Aaron%20Hupert",
      },
    ],
  },
  {
    slug: "anthony-hall",
    name: "Anthony Hall",
    alternateName: "Anthony Barry Hall",
    description:
      "Pro Medicus groups several shareholdings under Mr A Hall in its annual report.",
    filings: [
      {
        code: "PME",
        filedName: "Mr A Hall (multiple shareholdings)",
        aliases: ["Anthony Barry Hall", "Anthony Hall"],
        basis: "annual",
        sourceLabel: "Pro Medicus board biography",
        source:
          "https://www.promed.com.au/about/board/#:~:text=Anthony%20Barry%20Hall",
      },
    ],
  },
  {
    slug: "fiona-brown",
    name: "Fiona Brown",
    alternateName: "Fiona Tudor Brown",
    description:
      "Dicker Data lists Brown in two personal entries. Its directors’ report also identifies her interests in the two BTR companies on the register.",
    filings: [
      {
        code: "DDR",
        filedName: "Fiona Tudor Brown",
        aliases: ["Ms Fiona Tudor Brown", "Fiona Brown"],
        basis: "annual",
        sourceLabel: "Dicker Data directors’ interests · p. 78",
        source:
          "https://www.dickerdata.com.au/hubfs/Dicker%20Data/Investors/Announcement/2026/3030496.pdf#page=40",
      },
    ],
  },
  {
    slug: "graham-turner",
    name: "Graham Turner",
    description:
      "Flight Centre identifies Gainsdale as trustee for the Turner Family Trust, controlled by Graham Turner and his relatives. The register lists two parcels under the family account.",
    filings: [
      {
        code: "FLT",
        filedName: "Gainsdale Pty Ltd",
        basis: "annual",
        sourceLabel: "Flight Centre’s disclosure of control · p. 6",
        source:
          "https://company-announcements.afr.com/asx/flt/801f83ef-32d0-11f1-bb8a-ba3fd4a65388.pdf#page=6",
      },
    ],
  },
];

export type RankedHolder = {
  rank: number;
  name: string;
  shares: number;
  pct: number;
  profile: string;
  profileName?: string;
  jointNames?: readonly [string, string];
};

export type RegisterSnapshot = {
  code: string;
  company: string;
  date: string;
  dateBasis?: "financial-year-end";
  page: number;
  source: string;
  /** For lists without a printed rank, rank is the one-based row position. */
  orderedListSize?: number;
  holders: RankedHolder[];
};

// Each row is a transcribed registered account at its printed rank. Repeated
// names, joint names, and controlled-company entries are deliberately retained.
export const REGISTER_SNAPSHOTS: RegisterSnapshot[] = [
  ...annualRegisters,
  {
    code: "HVN",
    company: "Harvey Norman Holdings",
    date: "2026-08-26",
    page: 161,
    source:
      "https://cdn.shopify.com/s/files/1/0593/8003/9732/files/FY26_Annual_Report_and_Appendix_4E_to_upload.pdf?v=1787872483#page=161",
    holders: [
      {
        rank: 1,
        name: "Mr. Gerald Harvey",
        shares: 411121547,
        pct: 32.995,
        profile: "gerald-harvey",
      },
      {
        rank: 2,
        name: "Mr. Christopher Herbert Brown",
        shares: 205525565,
        pct: 16.495,
        profile: "hvn-christopher-herbert-brown",
      },
      {
        rank: 6,
        name: "Ms. Samantha Maree Harvey",
        shares: 29296144,
        pct: 2.351,
        profile: "hvn-samantha-maree-harvey",
      },
      {
        rank: 7,
        name: "Mr. Michael John Harvey",
        shares: 27300000,
        pct: 2.191,
        profile: "hvn-michael-john-harvey",
      },
      {
        rank: 10,
        name: "Ms. Kay Lesley Page",
        shares: 19526142,
        pct: 1.567,
        profile: "hvn-kay-lesley-page",
      },
      {
        rank: 18,
        name: "Mr. John Evyn Slack-Smith",
        shares: 1545671,
        pct: 0.124,
        profile: "hvn-john-evyn-slack-smith",
      },
      {
        rank: 19,
        name: "Mr. Chris Mentis",
        shares: 1275075,
        pct: 0.102,
        profile: "hvn-chris-mentis",
      },
      {
        rank: 20,
        name: "Mr. Arthur Bayly Brew",
        shares: 1252641,
        pct: 0.101,
        profile: "hvn-arthur-bayly-brew",
      },
    ],
  },
  {
    code: "MGH",
    company: "Maas Group Holdings",
    date: "2026-08-14",
    page: 179,
    source:
      "https://investors.maasgroup.com.au/DownloadFile.axd?file=%2FReport%2FComNews%2F20260820%2F03123199.pdf#page=180",
    holders: [
      {
        rank: 6,
        name: "MRS EMMA MARGARET MAAS",
        shares: 13783088,
        pct: 3.92,
        profile: "wesley-and-emma-maas",
      },
      {
        rank: 10,
        name: "MR WESLEY JON MAAS",
        shares: 5136355,
        pct: 1.46,
        profile: "wesley-and-emma-maas",
      },
      {
        rank: 12,
        name: "MRS LEESA JANE ROOKE",
        shares: 4853986,
        pct: 1.38,
        profile: "mgh-leesa-jane-rooke",
        profileName: "Leesa Jane Rooke",
      },
      {
        rank: 18,
        name: "MRS EMMA MARGARET MAAS",
        shares: 2566179,
        pct: 0.73,
        profile: "wesley-and-emma-maas",
      },
      {
        rank: 19,
        name: "MR WESLEY JON MAAS",
        shares: 2272710,
        pct: 0.65,
        profile: "wesley-and-emma-maas",
      },
      {
        rank: 20,
        name: "MR DAVID MICHAEL ROOKE",
        shares: 2218500,
        pct: 0.63,
        profile: "mgh-david-michael-rooke",
        profileName: "David Michael Rooke",
      },
    ],
  },
  {
    code: "WTC",
    company: "WiseTech Global",
    date: "2026-09-11",
    page: 229,
    source:
      "https://www.wisetechglobal.com/media/4o1lj2yf/wisetech-global-2026-annual-report.pdf#page=231",
    holders: [
      {
        rank: 1,
        name: "RealWise Holdings Pty Limited",
        shares: 92675710,
        pct: 27.56,
        profile: "richard-white",
      },
      {
        rank: 9,
        name: "Mr Michael John Gregg & Mrs Suzanne Jane Gregg",
        shares: 4500000,
        pct: 1.34,
        profile: "wtc-michael-and-suzanne-gregg",
        profileName: "Michael and Suzanne Gregg",
        jointNames: ["Michael John Gregg", "Suzanne Jane Gregg"],
      },
      {
        rank: 12,
        name: "RealWise Holdings Pty Limited",
        shares: 2602606,
        pct: 0.77,
        profile: "richard-white",
      },
    ],
  },
  {
    code: "PME",
    company: "Pro Medicus",
    date: "2026-06-30",
    dateBasis: "financial-year-end",
    page: 96,
    source:
      "https://www.promed.com.au/wp-content/uploads/2026/08/Financial-Report-30-June-2026.pdf#page=96",
    holders: [
      {
        rank: 1,
        name: "Mr A Hall (multiple shareholdings)",
        shares: 24174166,
        pct: 23.14,
        profile: "anthony-hall",
        profileName: "Anthony Hall",
      },
      {
        rank: 2,
        name: "Dr S Hupert (multiple shareholdings)",
        shares: 24196660,
        pct: 23.16,
        profile: "sam-hupert",
        profileName: "Sam Hupert",
      },
      {
        rank: 7,
        name: "Mr Peter Terence Kempen & Mrs Elaine Margaret Kempen (multiple shareholdings)",
        shares: 630082,
        pct: 0.6,
        profile: "pme-peter-and-elaine-kempen",
        profileName: "Peter and Elaine Kempen",
        jointNames: ["Peter Terence Kempen", "Elaine Margaret Kempen"],
      },
      {
        rank: 11,
        name: "Mr Stephen Geoffrey Wilson & Ms Denise Adele Prandi",
        shares: 267417,
        pct: 0.26,
        profile: "pme-stephen-wilson-and-denise-prandi",
        profileName: "Stephen Wilson and Denise Prandi",
        jointNames: ["Stephen Geoffrey Wilson", "Denise Adele Prandi"],
      },
      {
        rank: 12,
        name: "Mr Colin Gregory Organ",
        shares: 271000,
        pct: 0.26,
        profile: "pme-colin-gregory-organ",
      },
      {
        rank: 14,
        name: "Mr John Charles Plummer",
        shares: 250000,
        pct: 0.24,
        profile: "pme-john-charles-plummer",
      },
      {
        rank: 15,
        name: "Mr Michael Wu",
        shares: 228742,
        pct: 0.22,
        profile: "pme-michael-wu",
      },
      {
        rank: 16,
        name: "Mr Michael Wu & Ms Lynne Fan-Lin Wu Chen",
        shares: 212350,
        pct: 0.2,
        profile: "pme-michael-wu-and-lynne-wu-chen",
        profileName: "Michael Wu and Lynne Wu Chen",
        jointNames: ["Michael Wu", "Lynne Fan-Lin Wu Chen"],
      },
      {
        rank: 17,
        name: "Mr Bram Vander Jagt & Mrs Maaike Vander Jagt",
        shares: 138900,
        pct: 0.13,
        profile: "pme-bram-and-maaike-vander-jagt",
        profileName: "Bram and Maaike Vander Jagt",
        jointNames: ["Bram Vander Jagt", "Maaike Vander Jagt"],
      },
      {
        rank: 19,
        name: "Mr Kenneth John Vander Jagt & Mrs Tanya Vander Jagt",
        shares: 90000,
        pct: 0.09,
        profile: "pme-kenneth-and-tanya-vander-jagt",
        profileName: "Kenneth and Tanya Vander Jagt",
        jointNames: ["Kenneth John Vander Jagt", "Tanya Vander Jagt"],
      },
      {
        rank: 20,
        name: "Mr Malte Elias Westerhoff",
        shares: 87099,
        pct: 0.08,
        profile: "pme-malte-elias-westerhoff",
      },
    ],
  },
  {
    code: "DDR",
    company: "Dicker Data",
    date: "2026-02-03",
    page: 157,
    source:
      "https://www.dickerdata.com.au/hubfs/Dicker%20Data/Investors/Announcement/2026/3030496.pdf#page=79",
    holders: [
      {
        rank: 1,
        name: "Ms Fiona Tudor Brown",
        shares: 25702069,
        pct: 14.21,
        profile: "fiona-brown",
      },
      {
        rank: 3,
        name: "BTR No 2 Pty Ltd",
        shares: 21800000,
        pct: 12.06,
        profile: "fiona-brown",
      },
      {
        rank: 7,
        name: "Fiona Brown",
        shares: 5109572,
        pct: 2.83,
        profile: "fiona-brown",
      },
      {
        rank: 8,
        name: "BTR Investments No 1 Pty Ltd",
        shares: 2988598,
        pct: 1.65,
        profile: "fiona-brown",
      },
      {
        rank: 12,
        name: "Mr Vladimir Mitnovetski",
        shares: 1000000,
        pct: 0.55,
        profile: "vladimir-mitnovetski",
      },
      {
        rank: 16,
        name: "Mrs Rochelle Gilmore",
        shares: 427081,
        pct: 0.24,
        profile: "ddr-rochelle-gilmore",
      },
    ],
  },
  {
    code: "FLT",
    company: "Flight Centre Travel Group",
    date: "2026-07-31",
    page: 131,
    source:
      "https://links.sgx.com/FileOpen/2026.08.26%20Appendix%204E%20and%20FY26%20Annual%20Report.ashx?App=Announcement&FileID=902340#page=136",
    holders: [
      {
        rank: 4,
        name: "Gainsdale Pty Ltd <GF Turner Family A/C>",
        shares: 12849001,
        pct: 6.2,
        profile: "graham-turner",
      },
      {
        rank: 8,
        name: "Gainsdale Pty Ltd <GF Turner Family A/C>",
        shares: 3741897,
        pct: 1.8,
        profile: "graham-turner",
      },
    ],
  },
];

export const RANKED_HOLDERS = REGISTER_SNAPSHOTS.flatMap(
  ({ holders, ...report }) =>
    holders.map((holder) => ({ ...holder, ...report })),
);

const profiles = new Map(filingProfiles.map((person) => [person.slug, person]));
for (const holder of RANKED_HOLDERS) {
  if (!profiles.has(holder.profile)) {
    const withoutTitle = holder.name.replace(/^(?:mr|mrs|ms|dr)\.? +/i, "");
    profiles.set(holder.profile, {
      slug: holder.profile,
      name: holder.profileName ?? withoutTitle,
      ...(holder.jointNames && { jointNames: holder.jointNames }),
      description: holder.jointNames
        ? `${holder.company} lists ${holder.jointNames.join(" and ")} together in its annual top 20.`
        : `${holder.company} names this shareholder in its annual top-20 register.`,
      filings: [
        {
          code: holder.code,
          filedName: holder.name,
          source: holder.source,
          basis: "annual",
          aliases: [withoutTitle],
        },
      ],
    });
  }
}

export const AUSTRALIAN_INVESTORS = Array.from(profiles.values());
export const investorHref = (slug: string) =>
  `${AUSTRALIAN_INVESTORS_PATH}/${slug}`;
export const investorBySlug = (slug: string) => profiles.get(slug);
export const ranksForInvestor = (slug: string) =>
  RANKED_HOLDERS.filter((r) => r.profile === slug);
export const annualInterestsForInvestor = (person: AustralianInvestor) =>
  person.filings.flatMap((filing) =>
    filing.annualInterest
      ? [
          {
            ...filing.annualInterest,
            code: filing.code,
            holder: filing.filedName,
            source: filing.source,
          },
        ]
      : [],
  );
export const investorCodes = (p: AustralianInvestor) =>
  [
    ...new Set([
      ...p.filings.map((f) => f.code),
      ...ranksForInvestor(p.slug).map((r) => r.code),
    ]),
  ].sort();

export const TRACKED_ISSUERS = Array.from(
  new Set(AUSTRALIAN_INVESTORS.flatMap(investorCodes)),
).sort();

export const filedNameKey = (name: string) =>
  name.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
export const filingNames = (f: FilingIdentity) => [
  f.filedName,
  ...(f.aliases ?? []),
];
const filingProfilesByIssuerAndName = new Map(
  AUSTRALIAN_INVESTORS.flatMap((p) =>
    p.filings.flatMap((f) =>
      filingNames(f).map(
        (name) => [`${f.code}/${filedNameKey(name)}`, p] as const,
      ),
    ),
  ),
);

export const investorForFiling = (code: string, name: string) =>
  filingProfilesByIssuerAndName.get(`${code}/${filedNameKey(name)}`);

export const issuerInvestors = (code: string) =>
  AUSTRALIAN_INVESTORS.filter((p) => investorCodes(p).includes(code));

export const investorPct = (value: number) =>
  `${value.toLocaleString("en-AU", { maximumFractionDigits: 4 })}%`;
