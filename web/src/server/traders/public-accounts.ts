interface AccountSource {
  title: string;
  url: string;
}

export interface PublicAccount {
  platform:
    | "LinkedIn"
    | "X"
    | "Substack"
    | "YouTube"
    | "Instagram"
    | "Facebook"
    | "Official website";
  url: string;
  handle?: string;
  source: AccountSource;
}

export interface TraderAccounts {
  reviewedOn: string;
  organization?: string;
  personal: readonly PublicAccount[];
  firm?: readonly PublicAccount[];
  coHosted?: { name: string; accounts: readonly PublicAccount[] };
}

const milken: AccountSource = {
  title: "Milken Institute speaker profile",
  url: "https://milkeninstitute.org/events/global-conference-2026/speakers/brad-gerstner",
};
const bg2: AccountSource = {
  title: "BG2 Pod’s official site",
  url: "https://www.bg2pod.com/",
};
const wilsonPost: AccountSource = {
  title: "Wilson Asset Management’s post naming its chairman",
  url: "https://www.linkedin.com/posts/wilson-asset-management_chairman-and-chief-investment-officer-geoff-activity-7458021690225188864-A0Y5",
};
const wilsonBio: AccountSource = {
  title: "Geoff Wilson’s firm biography",
  url: "https://wilsonassetmanagement.com.au/about-us/geoff-wilson-ao/",
};
const wiseTechBoard: AccountSource = {
  title: "WiseTech Global board page",
  url: "https://www.wisetechglobal.com/investors/our-board-of-directors/",
};
const maasSite: AccountSource = {
  title: "Maas Group Holdings website",
  url: "https://www.maasgroup.com.au/",
};

// These are curated attributions. A name match or a share button does not
// establish who runs an account. Each source identifies its destination.
export const publicAccounts: Readonly<
  Record<string, TraderAccounts | undefined>
> = {
  "gina-rinehart": {
    reviewedOn: "2026-11-19",
    personal: [
      {
        platform: "Official website",
        url: "https://www.ginarinehart.com.au/",
        source: {
          title: "Gina Rinehart’s official site",
          url: "https://www.ginarinehart.com.au/",
        },
      },
    ],
  },
  "richard-white": {
    reviewedOn: "2026-11-19",
    organization: "WiseTech Global",
    personal: [],
    firm: [
      {
        platform: "LinkedIn",
        url: "https://www.linkedin.com/company/13728/",
        source: wiseTechBoard,
      },
      {
        platform: "X",
        url: "https://x.com/WiseTechGlobal",
        handle: "@WiseTechGlobal",
        source: wiseTechBoard,
      },
      {
        platform: "Facebook",
        url: "https://www.facebook.com/WiseTechGlobal",
        source: wiseTechBoard,
      },
      {
        platform: "YouTube",
        url: "https://www.youtube.com/channel/UCv78Idk92_k0VdFi7oZueyw",
        source: wiseTechBoard,
      },
    ],
  },
  "wesley-and-emma-maas": {
    reviewedOn: "2026-11-19",
    organization: "Maas Group Holdings",
    personal: [],
    firm: [
      {
        platform: "LinkedIn",
        url: "https://www.linkedin.com/company/maas-group-pty-limited/",
        source: maasSite,
      },
      {
        platform: "Instagram",
        url: "https://www.instagram.com/maasgroupholdings/",
        handle: "@maasgroupholdings",
        source: maasSite,
      },
      {
        platform: "Facebook",
        url: "https://www.facebook.com/maasgroupholdings",
        source: maasSite,
      },
    ],
  },
  "brad-gerstner": {
    reviewedOn: "2026-11-19",
    personal: [
      {
        platform: "LinkedIn",
        url: "https://www.linkedin.com/in/bradgerstner/",
        source: milken,
      },
      {
        platform: "X",
        url: "https://x.com/altcap",
        handle: "@altcap",
        source: milken,
      },
    ],
    firm: [
      {
        platform: "LinkedIn",
        url: "https://www.linkedin.com/company/altimeter-capital/",
        source: {
          title: "Altimeter’s Form ADV, section 1.I",
          url: "https://reports.adviserinfo.sec.gov/reports/ADV/160017/PDF/160017.pdf",
        },
      },
    ],
    coHosted: {
      name: "BG2 Pod with Bill Gurley",
      accounts: [
        {
          platform: "YouTube",
          url: "https://www.youtube.com/@Bg2Pod",
          handle: "@Bg2Pod",
          source: bg2,
        },
        {
          platform: "X",
          url: "https://x.com/bg2pod",
          handle: "@bg2pod",
          source: bg2,
        },
        {
          platform: "Instagram",
          url: "https://www.instagram.com/bg2pod/",
          handle: "@bg2pod",
          source: bg2,
        },
      ],
    },
  },
  "geoff-wilson": {
    reviewedOn: "2026-11-19",
    personal: [
      {
        platform: "LinkedIn",
        url: "https://www.linkedin.com/in/geoff-wilson-6bb15a362/",
        source: wilsonPost,
      },
      {
        platform: "X",
        url: "https://x.com/GeoffWilsonWAM",
        handle: "@GeoffWilsonWAM",
        source: wilsonBio,
      },
    ],
    firm: [
      {
        platform: "LinkedIn",
        url: "https://www.linkedin.com/company/wilson-asset-management/",
        source: wilsonBio,
      },
      {
        platform: "X",
        url: "https://x.com/WilsonAssetMgmt",
        handle: "@WilsonAssetMgmt",
        source: wilsonBio,
      },
      {
        platform: "Facebook",
        url: "https://www.facebook.com/WilsonAssetMgmt",
        source: wilsonBio,
      },
      {
        platform: "YouTube",
        url: "https://www.youtube.com/@wilsonassetmanagement3863",
        handle: "@wilsonassetmanagement3863",
        source: wilsonBio,
      },
    ],
  },
  "michael-burry": {
    reviewedOn: "2026-11-19",
    personal: [
      {
        platform: "X",
        url: "https://x.com/michaeljburry",
        handle: "@michaeljburry",
        source: {
          title: "Reuters’ report linking Burry’s X post",
          url: "https://www.reuters.com/sustainability/sustainable-finance-reporting/michael-burry-big-short-fame-deregisters-scion-asset-management-2025-11-13/",
        },
      },
      {
        platform: "Substack",
        url: "https://substack.com/@michaeljburry",
        handle: "@michaeljburry",
        source: {
          title: "Scion’s link to Burry’s Cassandra Unchained",
          url: "https://www.scionasset.com/",
        },
      },
    ],
  },
  "david-paradice": {
    reviewedOn: "2026-11-19",
    personal: [],
    firm: [
      {
        platform: "LinkedIn",
        url: "https://www.linkedin.com/company/paradice-investment-management-pty-ltd/",
        source: {
          title:
            "Helen Dalley’s interview with David Paradice, linking his Australian firm",
          url: "https://www.linkedin.com/posts/helen-dalley-800809202_managedfunds-financialmarkets-investing-activity-7475707660286287873-2EKB",
        },
      },
    ],
  },
};
