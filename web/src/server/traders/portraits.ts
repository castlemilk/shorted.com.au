/** Each local crop has a named subject, a credited original and a reuse basis. */
export interface InvestorPortrait {
  image: string;
  year: number;
  credit: string;
  creditUrl: string;
  source: string;
  license: string;
  licenseUrl: string;
}

export const portraits: Readonly<Record<string, InvestorPortrait | undefined>> =
  {
    "mike-cannon-brookes": {
      image: "/images/investors/mike-cannon-brookes.webp",
      year: 2018,
      credit: "Atlassian",
      creditUrl: "https://www.atlassian.com/",
      source:
        "https://commons.wikimedia.org/wiki/File:Mike_Cannon-Brookes_Australian_businessman.jpg",
      license: "CC0 1.0",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    },
    "gina-rinehart": {
      image: "/images/investors/gina-rinehart.webp",
      year: 2015,
      credit:
        "Department of Foreign Affairs and Trade website – www.dfat.gov.au",
      creditUrl: "https://www.dfat.gov.au/",
      source:
        "https://commons.wikimedia.org/wiki/File:Gina_Rinehart_June_2015.jpg",
      license: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    },
    "brad-gerstner": {
      image: "/images/investors/brad-gerstner.webp",
      year: 2025,
      credit: "Joyce N. Boghosian / The White House",
      creditUrl: "https://www.whitehouse.gov/",
      source:
        "https://commons.wikimedia.org/wiki/File:Brad_Gerstner_at_the_White_House_2025_(54581192563).jpg",
      license: "Public domain",
      licenseUrl: "https://creativecommons.org/publicdomain/mark/1.0/",
    },
  };

const harveyBoard =
  "https://www.harveynormanholdings.com.au/pages/board-of-directors";
function onHarveyBoard(name: string) {
  return {
    publisher: "Harvey Norman",
    url: `${harveyBoard}#:~:text=${encodeURIComponent(name)}`,
  };
}

/** A reader can view these captioned photos at the publisher. No local image is asserted. */
export const publisherPortraits: Readonly<
  Record<string, { publisher: string; url: string } | undefined>
> = {
  "russel-pillemer": {
    publisher: "Pengana Capital Group",
    url: "https://pengana.com/about-pengana/board-members/#:~:text=Russel%20Pillemer",
  },
  "sam-hupert": {
    publisher: "Pro Medicus",
    url: "https://www.promed.com.au/about/board/#:~:text=Dr%20Sam%20Aaron%20Hupert",
  },
  "anthony-hall": {
    publisher: "Pro Medicus",
    url: "https://www.promed.com.au/about/board/#:~:text=Anthony%20Barry%20Hall",
  },
  "fiona-brown": {
    publisher: "Dicker Data",
    url: "https://www.dickerdata.com.au/investor/board-of-directors#:~:text=Fiona%20Brown",
  },
  "vladimir-mitnovetski": {
    publisher: "Dicker Data",
    url: "https://www.dickerdata.com.au/investor/board-of-directors#:~:text=Vladimir%20Mitnovetski",
  },
  "geoff-wilson": {
    publisher: "Wilson Asset Management",
    url: "https://wilsonassetmanagement.com.au/about-us/geoff-wilson-ao/",
  },
  "richard-white": {
    publisher: "WiseTech Global",
    url: "https://www.wisetechglobal.com/investors/our-board-of-directors/#:~:text=Richard%20White",
  },
  "david-paradice": {
    publisher: "Paradice Investment Management",
    url: "https://paradice.com/team/#:~:text=David%20Paradice",
  },
  "gerald-harvey": onHarveyBoard("Gerry Harvey"),
  "hvn-kay-lesley-page": onHarveyBoard("Kay Lesley Page"),
  "hvn-michael-john-harvey": onHarveyBoard("Michael John Harvey"),
  "hvn-christopher-herbert-brown": onHarveyBoard("Christopher Herbert Brown"),
  "hvn-john-evyn-slack-smith": onHarveyBoard("John Evyn Slack-Smith"),
  "hvn-chris-mentis": onHarveyBoard("Chris Mentis"),
};
