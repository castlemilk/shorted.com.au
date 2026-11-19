import type { Metadata } from "next";
import { siteConfig } from "~/@/config/site";
import {
  investorHref,
  investorPct,
  ranksForInvestor,
  type AustralianInvestor,
} from "~/@/lib/ownership/australian-investors";
import { traderHref, type TraderProfile } from "~/@/lib/ownership/traders";
import { portraits, publisherPortraits } from "./portraits";
import { publicAccounts } from "./public-accounts";

type Investor = AustralianInvestor | TraderProfile;

export interface ProfessionalRecord {
  role: string;
  organization: string;
  milestone: { label: string; date: string };
  source: string;
  sourceLabel: string;
}

const board =
  "https://www.harveynormanholdings.com.au/pages/board-of-directors";

function harveyBoard(role: string, year: string): ProfessionalRecord {
  return {
    role,
    organization: "Harvey Norman Holdings",
    milestone: { label: "Joined the board", date: year },
    source: board,
    sourceLabel: "Harvey Norman board",
  };
}

// A named share register alone does not establish a job or directorship.
const appointments: Readonly<Record<string, ProfessionalRecord | undefined>> = {
  "mike-cannon-brookes": {
    role: "Co-founder and chief executive officer",
    organization: "Atlassian",
    milestone: { label: "Co-founded Atlassian", date: "2002" },
    source:
      "https://investors.atlassian.com/governance/management-team---board-of-directors/default.aspx",
    sourceLabel: "Atlassian board",
  },
  "russel-pillemer": {
    role: "Co-founder and chief executive officer",
    organization: "Pengana Capital Group",
    milestone: { label: "Co-founded Pengana", date: "2003" },
    source: "https://pengana.com/about-pengana/board-members/",
    sourceLabel: "Pengana board",
  },
  "sam-hupert": {
    role: "Co-founder, managing director and CEO",
    organization: "Pro Medicus",
    milestone: { label: "Co-founded Pro Medicus", date: "1983" },
    source: "https://www.promed.com.au/about/board/",
    sourceLabel: "Pro Medicus board",
  },
  "anthony-hall": {
    role: "Co-founder and technology director",
    organization: "Pro Medicus",
    milestone: { label: "Co-founded Pro Medicus", date: "1983" },
    source: "https://www.promed.com.au/about/board/",
    sourceLabel: "Pro Medicus board",
  },
  "fiona-brown": {
    role: "Co-founder, executive chair and managing director",
    organization: "Dicker Data",
    milestone: { label: "Co-founded Dicker Data", date: "1978" },
    source: "https://www.dickerdata.com.au/investor/board-of-directors",
    sourceLabel: "Dicker Data board",
  },
  "vladimir-mitnovetski": {
    role: "Executive director and chief operating officer",
    organization: "Dicker Data",
    milestone: { label: "Joined Dicker Data", date: "2010" },
    source: "https://www.dickerdata.com.au/investor/board-of-directors",
    sourceLabel: "Dicker Data board",
  },
  "gina-rinehart": {
    role: "Executive chairman",
    organization: "Hancock Prospecting",
    milestone: { label: "Became executive chairman", date: "1992" },
    source: "https://www.hancockprospecting.com.au/meet-our-team/",
    sourceLabel: "Hancock Prospecting",
  },
  "richard-white": {
    role: "Co-founder and executive director",
    organization: "WiseTech Global",
    milestone: { label: "Co-founded WiseTech", date: "1994" },
    source: "https://www.wisetechglobal.com/investors/our-board-of-directors/",
    sourceLabel: "WiseTech Global board",
  },
  "gerald-harvey": {
    ...harveyBoard("Executive chairman", "1987"),
    milestone: { label: "Co-founded Harvey Norman", date: "1982" },
  },
  "hvn-christopher-herbert-brown": harveyBoard(
    "Non-executive director",
    "1987",
  ),
  "hvn-kay-lesley-page": harveyBoard(
    "Executive director and chief executive officer",
    "1987",
  ),
  "hvn-michael-john-harvey": harveyBoard("Non-executive director", "1993"),
  "hvn-john-evyn-slack-smith": harveyBoard(
    "Executive director and chief operating officer",
    "2001",
  ),
  "hvn-chris-mentis": harveyBoard(
    "Executive director, CFO and company secretary",
    "2007",
  ),
};

export function professionalRecord(
  person: Investor,
): ProfessionalRecord | undefined {
  if (!("reporting" in person)) {
    const record = appointments[person.slug];
    const biography = publisherPortraits[person.slug]?.url;
    return record && biography?.startsWith(record.source + "#")
      ? { ...record, source: biography }
      : record;
  }
  return {
    role: person.role,
    organization: person.firm,
    milestone: person.milestone,
    source: person.roleSource,
    sourceLabel: person.reporting.market === "US" ? "SEC filing" : person.firm,
  };
}

const dateFormat = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
export function displayRecordDate(date: string): string {
  if (date.length === 4) return date;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === date
    ? dateFormat.format(parsed)
    : date;
}

function profileUrl(person: Investor) {
  const path =
    "reporting" in person ? traderHref(person) : investorHref(person.slug);
  return siteConfig.url + path;
}

function descriptionFor(person: Investor): string {
  if ("reporting" in person) {
    const filing =
      person.reporting.market === "ASX"
        ? "ASX holder notices"
        : "SEC holdings reports";
    if (person.roleAsOf) {
      return `${person.name} signed for ${person.firm} on ${displayRecordDate(person.roleAsOf)}. Explore the firm’s ${filing} and positions by quarter.`;
    }
    return `${person.name} ${person.milestone.label.charAt(0).toLowerCase() + person.milestone.label.slice(1)} in ${person.milestone.date}. View the ${filing} for ${person.firm}.`;
  }
  const record = professionalRecord(person);
  const lead = record ? `${record.role} at ${record.organization}. ` : "";
  const ranks = ranksForInvestor(person.slug);
  if (ranks.length === 1 && person.filings.every((f) => f.basis === "annual")) {
    const rank = ranks[0]!;
    const period = rank.dateBasis
      ? `annual report for the year ended ${displayRecordDate(rank.date)}`
      : `${displayRecordDate(rank.date)} shareholder register`;
    return `${lead}${rank.company} lists ${person.name} at rank ${rank.rank} (${investorPct(rank.pct)}) in its ${period}.`;
  }
  return lead + person.description;
}

export function investorPageMetadata(person: Investor): Metadata {
  const url = profileUrl(person);
  const title =
    "reporting" in person
      ? `${person.name} | Disclosed holdings`
      : `${person.name} · ASX ownership disclosures`;
  const description = descriptionFor(person);
  const images = [
    {
      url: url + "/opengraph-image",
      width: 1200,
      height: 630,
      alt: `${person.name} · disclosure record on Shorted`,
    },
  ];
  const social = { title, description, images };
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      ...social,
      url,
      siteName: siteConfig.name,
      locale: "en_AU",
      type: "jointNames" in person && person.jointNames ? "website" : "profile",
    },
    twitter: { ...social, site: "@shorted___", card: "summary_large_image" },
  };
}

export function investorPageSchema(
  person: Investor,
  filingSources: string[] = [],
) {
  const url = profileUrl(person);
  const description = descriptionFor(person);
  const record = professionalRecord(person);
  const accounts = publicAccounts[person.slug];
  const firmName =
    accounts?.organization ?? ("reporting" in person ? person.firm : undefined);
  const firm = firmName && {
    "@type": "Organization",
    name: firmName,
    ...(accounts?.firm?.length && { sameAs: accounts.firm.map((a) => a.url) }),
    ...("reporting" in person &&
      person.reporting.market === "US" && {
        identifier: {
          "@type": "PropertyValue",
          propertyID: "SEC CIK",
          value: person.reporting.cik,
        },
      }),
  };
  const sources = new Set(filingSources);
  if ("filings" in person) {
    for (const filing of person.filings) sources.add(filing.source);
    for (const rank of ranksForInvestor(person.slug)) sources.add(rank.source);
  }
  if (record) sources.add(record.source);
  const page = {
    "@context": "https://schema.org",
    "@id": url + "#profile",
    url,
    name: person.name,
    description,
    ...(firm && { mentions: firm }),
    ...(sources.size && {
      citation: [...sources].map((source) => ({
        "@type": "CreativeWork",
        url: source,
      })),
    }),
  };
  if ("jointNames" in person && person.jointNames) {
    return {
      ...page,
      "@type": "CollectionPage",
      about: person.jointNames.map((name) => ({ "@type": "Person", name })),
    };
  }
  const portrait = portraits[person.slug];
  return {
    ...page,
    "@type": "ProfilePage",
    mainEntity: {
      "@type": "Person",
      "@id": url + "#person",
      name: person.name,
      ...("alternateName" in person && { alternateName: person.alternateName }),
      url,
      ...(record &&
        !("roleAsOf" in person && person.roleAsOf) && {
          jobTitle: record.role,
          affiliation: { "@type": "Organization", name: record.organization },
        }),
      ...(portrait && {
        image: {
          "@type": "ImageObject",
          contentUrl: siteConfig.url + portrait.image,
          creditText: portrait.credit,
          license: portrait.licenseUrl,
          isBasedOn: portrait.source,
        },
      }),
      ...(accounts?.personal.length && {
        sameAs: accounts.personal.map((a) => a.url),
      }),
    },
  };
}
