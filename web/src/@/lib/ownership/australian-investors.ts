/** An ASX issuer and a filing together establish an identity. A surname, fund
 * manager or custodian is never evidence for a cross-issuer link. */
export const AUSTRALIAN_INVESTORS_PATH = "/ownership/traders/australia";

export type FilingIdentity = {
  code: string;
  filedName: string;
  source: string;
  basis?: "annual";
  aliases?: string[];
};

export type AustralianInvestor = {
  slug: string;
  name: string;
  description: string;
  filings: FilingIdentity[];
};

const asxFiling = (
  code: string,
  filedName: string,
  id: string,
): FilingIdentity => ({
  code,
  filedName,
  source: `https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=${id}`,
});

const filingProfiles: AustralianInvestor[] = [
  {
    slug: "gina-rinehart",
    name: "Gina Rinehart",
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
];

export type RankedHolder = {
  rank: number;
  name: string;
  shares: number;
  pct: number;
  profile: string;
};

type RegisterSnapshot = {
  code: string;
  company: string;
  date: string;
  page: number;
  source: string;
  holders: RankedHolder[];
};

// Each row is a transcribed registered account at its printed rank. Repeated
// names, joint names, and controlled-company entries are deliberately retained.
export const REGISTER_SNAPSHOTS: RegisterSnapshot[] = [
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
];

export const RANKED_HOLDERS = REGISTER_SNAPSHOTS.flatMap(
  ({ holders, ...report }) =>
    holders.map((holder) => ({ ...holder, ...report })),
);

const profiles = new Map(filingProfiles.map((person) => [person.slug, person]));
for (const holder of RANKED_HOLDERS) {
  if (!profiles.has(holder.profile)) {
    profiles.set(holder.profile, {
      slug: holder.profile,
      name: holder.name,
      description: `${holder.company} names this shareholder in its annual top-20 register.`,
      filings: [
        {
          code: holder.code,
          filedName: holder.name,
          source: holder.source,
          basis: "annual",
          aliases: [holder.name.replace(/^(?:mr|mrs|ms)\.? +/i, "")],
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
export const investorCodes = (p: AustralianInvestor) =>
  [
    ...new Set([
      ...p.filings.map((f) => f.code),
      ...ranksForInvestor(p.slug).map((r) => r.code),
    ]),
  ].sort();

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
