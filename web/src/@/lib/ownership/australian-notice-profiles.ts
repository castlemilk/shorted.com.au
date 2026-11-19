import type { AustralianInvestor } from "./australian-investors";

// Each notice was checked against the released form, including joint filers and associates.
export const noticeProfiles: AustralianInvestor[] = [
  {
    slug: "mike-cannon-brookes",
    name: "Mike Cannon-Brookes",
    alternateName: "Michael Alexander Cannon-Brookes",
    description:
      "The AGL notice names Michael Alexander Cannon-Brookes with Galipea Partnership and its related entities. Its voting power is reported for the group.",
    filings: [
      {
        code: "AGL",
        filedName: "Michael Alexander Cannon-Brookes, Galipea Partnership",
        source:
          "https://boldinvestors.com.au/asx/agl/announcements/21691515/change-in-substantial-holding",
        notice: {
          company: "AGL Energy",
          date: "2026-08-24",
          form: "604",
          pct: 9.41,
          announcementId: "03129162",
        },
      },
    ],
  },
  {
    slug: "russel-pillemer",
    name: "Russel Pillemer",
    alternateName: "Russel Craig Pillemer",
    description:
      "Pengana’s co-founder reports his voting interest in the listed fund manager. The notice includes an off-market sale of 4,333,333 shares.",
    filings: [
      {
        code: "PCG",
        filedName: "Russel Craig Pillemer",
        source:
          "https://boldinvestors.com.au/asx/pcg/announcements/21707596/change-in-substantial-holding-for-russel-pillemer",
        notice: {
          company: "Pengana Capital Group",
          date: "2026-10-30",
          form: "604",
          pct: 20.7,
          announcementId: "03160669",
        },
      },
    ],
  },
  {
    slug: "tolga-kumova",
    name: "Tolga Kumova",
    description:
      "Torque Metals published Kumova’s notice of ceasing to be a substantial holder. It records the end of substantial-holder reporting.",
    filings: [
      {
        code: "TOR",
        filedName: "Tolga Kumova",
        source:
          "https://asx.api.markitdigital.com/asx-research/1.0/file/2924-03157276-6A1353329",
        notice: {
          company: "Torque Metals",
          date: "2026-11-03",
          form: "605",
          pct: null,
          announcementId: "03161335",
        },
      },
    ],
  },
  {
    slug: "joshua-gordon",
    name: "Joshua Gordon",
    description:
      "Reedy Lagoon’s notice lists 208 million votes both before and after the change. His percentage fell as the company issued shares.",
    filings: [
      {
        code: "RLC",
        filedName: "MR JOSHUA GORDON",
        source:
          "https://boldinvestors.com.au/asx/rlc/announcements/3705808/change-in-substantial-holding",
        notice: {
          company: "Reedy Lagoon",
          date: "2026-11-04",
          form: "604",
          pct: 8.16,
          announcementId: "03162068",
        },
      },
    ],
  },
  {
    slug: "andrew-dyer",
    name: "Andrew Dyer",
    description:
      "Adslot’s notice covers Andrew Dyer and his associates. It reports their combined voting interest.",
    filings: [
      {
        code: "ADS",
        filedName: "Andrew Dyer",
        source:
          "https://asx.api.markitdigital.com/asx-research/1.0/file/2924-03157460-3A705709",
        notice: {
          company: "Adslot",
          date: "2026-11-03",
          form: "604",
          pct: 10.28,
          announcementId: "03161519",
        },
      },
    ],
  },
  {
    slug: "peter-mcutchen",
    name: "Peter McUtchen",
    description:
      "PARKD’s notice records a larger number of votes and a smaller percentage of voting power after the company issued shares.",
    filings: [
      {
        code: "PKD",
        filedName: "PETER MCUTCHEN",
        source:
          "https://boldinvestors.com.au/asx/pkd/announcements/61351760/change-in-substantial-holding",
        notice: {
          company: "PARKD",
          date: "2026-10-27",
          form: "604",
          pct: 7.69,
          announcementId: "03158000",
        },
      },
    ],
  },
  {
    slug: "mathew-walker",
    name: "Mathew Walker",
    description:
      "The Blaze Minerals filing names both direct holdings and interests held through the Walker family account.",
    filings: [
      {
        code: "BLZ",
        filedName: "MATHEW WALKER",
        source:
          "https://boldinvestors.com.au/asx/blz/announcements/61353061/change-in-substantial-holding",
        notice: {
          company: "Blaze Minerals",
          date: "2026-10-30",
          form: "604",
          pct: 8.88,
          announcementId: "03160656",
        },
      },
    ],
  },
  {
    slug: "steven-formica",
    name: "Steven Formica",
    description:
      "Albion’s filing reports the same 10.75 million votes at a lower percentage after a share issue.",
    filings: [
      {
        code: "ALB",
        filedName: "Steven Formica",
        source:
          "https://asx.api.markitdigital.com/asx-research/1.0/file/2924-03153696-6A1351647",
        notice: {
          company: "Albion Resources",
          date: "2026-10-27",
          form: "604",
          pct: 6.08,
          announcementId: "03157755",
        },
      },
    ],
  },
  {
    slug: "oliver-kiddie",
    name: "Oliver Kiddie",
    description:
      "FMR Resources names Kiddie and the trust accounts included in his initial substantial holding notice.",
    filings: [
      {
        code: "FMR",
        filedName: "Oliver Kiddie",
        source:
          "https://asx.api.markitdigital.com/asx-research/1.0/file/2924-03153531-6A1351584",
        notice: {
          company: "FMR Resources",
          date: "2026-10-27",
          form: "603",
          pct: 6.94,
          announcementId: "03157590",
        },
      },
    ],
  },
  {
    slug: "adrian-griffin",
    name: "Adrian Griffin",
    alternateName: "Adrian Christopher Griffin",
    description:
      "The BoA Resources notice lists Griffin’s individual and jointly held shares in its account of voting power.",
    filings: [
      {
        code: "BOA",
        filedName: "Adrian Griffin",
        source:
          "https://boldinvestors.com.au/asx/boa/announcements/61350270/becoming-a-substantial-holder",
        notice: {
          company: "BoA Resources",
          date: "2026-10-20",
          form: "603",
          pct: 12.68,
          announcementId: "03154818",
        },
      },
    ],
  },
  {
    slug: "rory-luff",
    name: "Rory Luff",
    description:
      "Turnstone’s notice includes shares held through Luff’s superannuation account.",
    filings: [
      {
        code: "TSR",
        filedName: "Rory Luff",
        source:
          "https://boldinvestors.com.au/asx/tsr/announcements/61351411/change-in-substantial-holding",
        notice: {
          company: "Turnstone Resources",
          date: "2026-10-26",
          form: "604",
          pct: 7.7,
          announcementId: "03157278",
        },
      },
    ],
  },
  {
    slug: "margaret-aboody",
    name: "Margaret Aboody",
    description:
      "Gold Hydrogen’s initial notice identifies Aboody as the holder of 14.5 million ordinary shares.",
    filings: [
      {
        code: "GHY",
        filedName: "Margaret Aboody",
        source:
          "https://boldinvestors.com.au/asx/ghy/announcements/21704081/becoming-a-substantial-holder",
        notice: {
          company: "Gold Hydrogen",
          date: "2026-10-14",
          form: "603",
          pct: 8.035,
          announcementId: "03152480",
        },
      },
    ],
  },
  {
    slug: "greg-jinks",
    name: "Greg Jinks",
    description:
      "The SKS Technologies notice records a change from 12,552,692 to 8,095,692 votes.",
    filings: [
      {
        code: "SKS",
        filedName: "Greg Jinks",
        source:
          "https://asx.api.markitdigital.com/asx-research/1.0/file/2924-03146209-3A703684",
        notice: {
          company: "SKS Technologies Group",
          date: "2026-10-08",
          form: "604",
          pct: 7.01,
          announcementId: "03150268",
        },
      },
    ],
  },
  {
    slug: "jonathan-rosham",
    name: "Jonathan Rosham",
    description:
      "ACDC Metals names Rosham in the initial notice covering voting and disposal rights over 7,157,334 ordinary shares.",
    filings: [
      {
        code: "ADC",
        filedName: "Jonathan Rosham",
        source:
          "https://boldinvestors.com.au/asx/adc/announcements/3703425/notice-of-initial-substantial-holder",
        notice: {
          company: "ACDC Metals",
          date: "2026-10-06",
          form: "603",
          pct: 5.96,
          announcementId: "03148962",
        },
      },
    ],
  },
  {
    slug: "arun-and-susmita-singh",
    name: "Arun and Susmita Singh",
    jointNames: ["Arun Singh", "Susmita Singh"],
    description:
      "CurveBeam AI names Arun Singh and Susmita Singh together. Their notice reports the same number of votes before and after the change.",
    filings: [
      {
        code: "CVB",
        filedName: "Arun Singh & Susmita Singh",
        source:
          "https://boldinvestors.com.au/asx/cvb/announcements/3703974/change-in-substantial-holding-arun-susmita-singh",
        notice: {
          company: "CurveBeam AI",
          date: "2026-10-13",
          form: "604",
          pct: 16.81,
          announcementId: "03151766",
        },
      },
    ],
  },
  {
    slug: "charles-bennett-bass",
    name: "Charles Bennett Bass",
    description:
      "Eagle Mountain Mining’s notice names Bass with Silver Mountain Mining Nominee. It reports voting power across the interests in the filing.",
    filings: [
      {
        code: "EM2",
        filedName: "Charles Bennett Bass",
        source:
          "https://boldinvestors.com.au/asx/em2/announcements/61348159/change-in-substantial-holding",
        notice: {
          company: "Eagle Mountain Mining",
          date: "2026-10-07",
          form: "604",
          pct: 31.7,
          announcementId: "03149784",
        },
      },
    ],
  },
  {
    slug: "craig-douglas-mitchell",
    name: "Craig Douglas Mitchell",
    description:
      "The Fenix Resources filing names Mitchell together with Exxten and C&T Mitchell Super. Voting power covers all three.",
    filings: [
      {
        code: "FEX",
        filedName: "1) Craig Douglas Mitchell",
        source:
          "https://boldinvestors.com.au/asx/fex/announcements/61339947/change-in-substantial-holding",
        notice: {
          company: "Fenix Resources",
          date: "2026-08-24",
          form: "604",
          pct: 9.67,
          announcementId: "03129190",
        },
      },
    ],
  },
  {
    slug: "gaetano-russo",
    name: "Gaetano Russo",
    alternateName: "Gaetano Alfred Gerrard Russo",
    description:
      "Guzman y Gomez published Russo’s notice of ceasing to be a substantial holder after two sales of ordinary shares.",
    filings: [
      {
        code: "GYG",
        filedName: "Gaetano Alfred Gerrard Russo",
        source:
          "https://boldinvestors.com.au/asx/gyg/announcements/21703931/ceasing-to-be-a-substantial-holder",
        notice: {
          company: "Guzman y Gomez",
          date: "2026-10-14",
          form: "605",
          pct: null,
          announcementId: "03152166",
        },
      },
    ],
  },
];
