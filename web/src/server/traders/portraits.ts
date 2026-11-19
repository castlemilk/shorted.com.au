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
    "andrew-forrest": {
      image: "/images/investors/andrew-forrest.webp",
      year: 2025,
      credit: "Xuthoria",
      creditUrl: "https://commons.wikimedia.org/wiki/User:Xuthoria",
      source:
        "https://commons.wikimedia.org/wiki/File:NYCW_2025_-_Andrew_Forrest_02_(cropped).jpg",
      license: "CC BY-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    },
    "ruslan-kogan": {
      image: "/images/investors/ruslan-kogan.webp",
      year: 2010,
      credit: "Kogan Technologies",
      creditUrl: "https://www.flickr.com/photos/kogantech/4753161831/",
      source:
        "https://commons.wikimedia.org/wiki/File:Ruslan_Kogan_Founder_and_CEO_Kogan_Technologies.jpg",
      license: "CC BY 2.0",
      licenseUrl: "https://creativecommons.org/licenses/by/2.0/",
    },
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
function onHarveyBoard(name: string, image: string) {
  return {
    image,
    publisher: "Harvey Norman",
    url: `${harveyBoard}#:~:text=${encodeURIComponent(name)}`,
  };
}

/** Captioned professional photographs remain hosted at the publisher. Each links to the identifying biography. */
export const publisherPortraits: Readonly<
  Record<string, { publisher: string; url: string; image?: string } | undefined>
> = {
  "oliver-kiddie": {
    publisher: "FMR Resources",
    url: "https://fmrresources.com.au/investors/board-and-management/#:~:text=Oliver%20Kiddie",
    image:
      "https://fmrresources.com.au/wp-content/uploads/2025/12/Oliver-Kiddie_1_1-Dec-300x300.jpeg",
  },
  "matthew-heine": {
    publisher: "Netwealth",
    url: "https://www.netwealth.com.au/web/about-netwealth/our-people/#:~:text=Matt%20Heine",
    image: "https://www.netwealth.com.au/web/media/90540/matt-heine_1.png",
  },
  "michael-heine": {
    publisher: "Netwealth",
    url: "https://www.netwealth.com.au/web/about-netwealth/our-people/#:~:text=Michael%20Heine",
    image: "https://www.netwealth.com.au/web/media/79049/michael-heine.png",
  },
  "brett-blundy": {
    publisher: "BBRC Private Equity",
    url: "https://www.bbrcpe.com/#:~:text=BRETT%20BLUNDY",
    image:
      "https://static.wixstatic.com/media/a7ba1b_62842278a1634d0491efa67393085f42~mv2.png/v1/fill/w_200,h_200,al_c,q_85,usm_0.66_1.00_0.01,enc_avif,quality_auto/BB%20headshot.png",
  },
  "graham-turner": {
    publisher: "Flight Centre Travel Group",
    url: "https://www.fctgl.com/corporate-directory#:~:text=Graham%20Turner",
    image:
      "https://cdn.prod.website-files.com/643e6b4601023f66d9745f21/6614458aa8ba0a6df1852baa_64497fa6981c89358be10c29_Skroo%2520-%2520board_v1.jpeg",
  },
  "kerry-stokes": {
    publisher: "Peter Brew-Bevan / National Portrait Gallery",
    url: "https://portrait.gov.au/portraits/2021.15/kerry-stokes",
  },
  "ryan-stokes": {
    image:
      "https://sghl.com.au/assets/Uploads/eb26de5f7b/Ryan-Stokes3__FillWzQwOCwyMzVd.jpg",
    publisher: "SGH",
    url: "https://sghl.com.au/who-we-are/executive-management#:~:text=Ryan%20Stokes",
  },
  "kees-weel": {
    image:
      "https://www.pwr.com.au/app/uploads/2021/07/Designer-2026-08-06T145212.201-300x200.jpg",
    publisher: "PWR",
    url: "https://www.pwr.com.au/meet-the-team/kees-weel/",
  },
  "russel-pillemer": {
    image:
      "https://pengana.com/wp-content/uploads/team-photos/Russel-Pillemer.png",
    publisher: "Pengana Capital Group",
    url: "https://pengana.com/about-pengana/board-members/#:~:text=Russel%20Pillemer",
  },
  "sam-hupert": {
    image:
      "https://www.promed.com.au/wp-content/uploads/2021/10/Sam-200-x-200.jpg",
    publisher: "Pro Medicus",
    url: "https://www.promed.com.au/about/board/#:~:text=Dr%20Sam%20Aaron%20Hupert",
  },
  "anthony-hall": {
    image:
      "https://www.promed.com.au/wp-content/uploads/2021/10/anthony-color-1-1.jpg",
    publisher: "Pro Medicus",
    url: "https://www.promed.com.au/about/board/#:~:text=Anthony%20Barry%20Hall",
  },
  "fiona-brown": {
    image:
      "https://www.dickerdata.com.au/hs-fs/hubfs/Dicker%20Data/About%20Us/Fiona-cropped.jpg?width=240&name=Fiona-cropped.jpg",
    publisher: "Dicker Data",
    url: "https://www.dickerdata.com.au/investor/board-of-directors#:~:text=Fiona%20Brown",
  },
  "vladimir-mitnovetski": {
    image:
      "https://www.dickerdata.com.au/hs-fs/hubfs/Dicker%20Data/About%20Us/Vladimir%20Mitnovetski_2023-cropped.jpg?width=240&name=Vladimir%20Mitnovetski_2023-cropped.jpg",
    publisher: "Dicker Data",
    url: "https://www.dickerdata.com.au/investor/board-of-directors#:~:text=Vladimir%20Mitnovetski",
  },
  "geoff-wilson": {
    image:
      "https://wilsonassetmanagement.com.au/wp-content/uploads/2023/05/1197fbbbaf147cd9e5c2be7c66e4c4b7-e1786325427803.jpg",
    publisher: "Wilson Asset Management",
    url: "https://wilsonassetmanagement.com.au/about-us/geoff-wilson-ao/",
  },
  "richard-white": {
    image:
      "https://www.wisetechglobal.com/media/rwididh1/richard-white-rounded-corners.png",
    publisher: "WiseTech Global",
    url: "https://www.wisetechglobal.com/investors/our-board-of-directors/#:~:text=Richard%20White",
  },
  "david-paradice": {
    image:
      "https://paradice.com/wp-content/uploads/2022/08/David-Paradice-Paradice-Investment.jpg",
    publisher: "Paradice Investment Management",
    url: "https://paradice.com/team/#:~:text=David%20Paradice",
  },
  "gerald-harvey": onHarveyBoard(
    "Gerry Harvey",
    "https://images.squarespace-cdn.com/content/v1/54803162e4b08e1b8a472201/1574393358769-PJ3KUWXF6653ZXQ41TH1/jerry.jpg?format=300w",
  ),
  "hvn-kay-lesley-page": onHarveyBoard(
    "Kay Lesley Page",
    "https://images.squarespace-cdn.com/content/v1/54803162e4b08e1b8a472201/1574393422399-E62USGI6U0CYZUH3YWON/kay.jpg?format=300w",
  ),
  "hvn-michael-john-harvey": onHarveyBoard(
    "Michael John Harvey",
    "https://images.squarespace-cdn.com/content/v1/54803162e4b08e1b8a472201/1574393632867-1WIZ47546UP40B6LV43N/michael.jpg?format=300w",
  ),
  "hvn-christopher-herbert-brown": onHarveyBoard(
    "Christopher Herbert Brown",
    "https://images.squarespace-cdn.com/content/v1/54803162e4b08e1b8a472201/1574393672662-H4QTP6K6APXYZA74WUA9/image-asset.jpeg?format=300w",
  ),
  "hvn-john-evyn-slack-smith": onHarveyBoard(
    "John Evyn Slack-Smith",
    "https://images.squarespace-cdn.com/content/v1/54803162e4b08e1b8a472201/1574393537014-3XGBJUP8J57H9GG9JWBP/JSS.jpg?format=300w",
  ),
  "hvn-chris-mentis": onHarveyBoard(
    "Chris Mentis",
    "https://images.squarespace-cdn.com/content/v1/54803162e4b08e1b8a472201/1574393469840-Q6ZQG9ZCH4CNKW9YGE9Y/chris2.jpg?format=300w",
  ),
  "david-shafer": {
    publisher: "Kogan.com",
    url: "https://www.kogancorporate.com/#DavidShafer",
    image:
      "https://www.kogancorporate.com/resources/images/Team/DavidShafer.png",
  },
  "nicola-forrest": {
    publisher: "Forrest Research Foundation",
    url: "https://forrestresearch.org.au/members/dr-nicola-forrest/",
    image:
      "https://forrestresearch.org.au/wp-content/uploads/2023/11/Nicola-Forrest-Headshot-reduced-file-size-crop-1024x1019.jpeg",
  },
  "kgn-goran-stefkovski": {
    publisher: "Factor",
    url: "https://app.factor-insights.com/events/cto-day-sydney#:~:text=Goran%20Stefkovski",
    image:
      "https://panelist-prod-media.s3.ap-southeast-2.amazonaws.com/images/2026629/b9f73761-f6aa-44e8-a42a-35a65d7edfca-sc120voh/blob",
  },
  "chris-ellison": {
    publisher: "Mineral Resources",
    url: "https://www.mineralresources.com.au/about-us/leadership/chris-ellison/",
    image:
      "https://cdn.sanity.io/images/o6ep64o3/production/a69323a786d0d11532da444116b1ab3281335f32-1080x608.jpg?w=320&fm=webp&q=80&auto=format",
  },
};

export interface ProfilePicture {
  image: string;
  subject: string;
  source: string;
  credit: string;
  local?: InvestorPortrait;
}

function namedPicture(slug: string, subject: string): ProfilePicture[] {
  const local = portraits[slug];
  if (local)
    return [
      {
        image: local.image,
        subject,
        source: local.source,
        credit: local.credit,
        local,
      },
    ];
  const publisher = publisherPortraits[slug];
  return publisher?.image
    ? [
        {
          image: publisher.image,
          subject,
          source: publisher.url,
          credit: publisher.publisher,
        },
      ]
    : [];
}

export function profilePictures(slug: string, name = slug): ProfilePicture[] {
  if (slug === "andrew-and-nicola-forrest")
    return [
      ...namedPicture("andrew-forrest", "Andrew Forrest"),
      ...namedPicture("nicola-forrest", "Nicola Forrest"),
    ];
  return namedPicture(slug, name);
}
