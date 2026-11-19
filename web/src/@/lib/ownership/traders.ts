export const TRADERS_PATH = "/ownership/traders";

export interface TraderProfile {
  slug: string;
  name: string;
  firm: string;
  role: string;
  roleSource: string;
  reporting: { market: "ASX"; holder: string } | { market: "US"; cik: string };
  director?: { code: string; name: string; source: string };
}

// A person is connected to a reporting entity by an explicit, sourced relationship.
// The ASX key is the ownership registry's slug and the SEC key is the manager's CIK.
export const TRADERS: readonly TraderProfile[] = [
  {
    slug: "brad-gerstner",
    name: "Brad Gerstner",
    firm: "Altimeter Capital Management, LP",
    role: "Founder",
    roleSource:
      "https://www.sec.gov/Archives/edgar/data/1830232/000114036121000703/nt10017539x6_424b4.htm",
    reporting: { market: "US", cik: "0001541617" },
  },
  {
    slug: "geoff-wilson",
    name: "Geoff Wilson",
    firm: "Wilson Asset Management",
    role: "Founder",
    roleSource:
      "https://wilsonassetmanagement.com.au/about-us/geoff-wilson-ao/",
    reporting: { market: "ASX", holder: "wilson-asset-management" },
    director: {
      code: "WAM",
      name: "Geoff Wilson",
      source:
        "https://company-announcements.afr.com/asx/wam/c653edb8-bcd8-11ef-8c82-326e3e074053.pdf",
    },
  },
  {
    slug: "michael-burry",
    name: "Michael Burry",
    firm: "Scion Asset Management, LLC",
    role: "CEO signing the September 2025 filing",
    roleSource:
      "https://www.sec.gov/Archives/edgar/data/1649339/000164933925000007/xslForm13F_X02/primary_doc.xml",
    reporting: { market: "US", cik: "0001649339" },
  },
  {
    slug: "david-paradice",
    name: "David Paradice",
    firm: "Paradice Investment Management",
    role: "Founder",
    roleSource: "https://paradice.com/about/",
    reporting: { market: "ASX", holder: "paradice" },
  },
];

export function traderHref(trader: TraderProfile): string {
  return `${TRADERS_PATH}/${trader.slug}`;
}

export function tradersForHolder(slug: string): TraderProfile[] {
  return TRADERS.filter(
    ({ reporting }) => reporting.market === "ASX" && reporting.holder === slug,
  );
}

export const DIRECTOR_READ_LIMIT = 200;
export const ASX_CODE = /^[A-Z0-9]{3,4}$/;

export function directorKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export function directorHref(code: string, name?: string): string {
  const path = `${TRADERS_PATH}/asx/${encodeURIComponent(code)}`;
  return name
    ? `${path}?${new URLSearchParams({ director: directorKey(name) }).toString()}`
    : path;
}

// The headline reader writes "Unknown Director", zero units and a default direction
// until the document reader recovers the figures. Only quantified, named rows can
// support a person's transaction history.
export function isNamedDirectorTrade(trade: {
  directorName: string;
  sharesTraded?: bigint | number;
}): boolean {
  const name = directorKey(trade.directorName);
  return (
    name !== "" &&
    !/^(unknown( director)?|unspecified|undisclosed|n\/?a|not (available|disclosed)|-)$/.test(
      name,
    ) &&
    (trade.sharesTraded ?? 0) > 0
  );
}
