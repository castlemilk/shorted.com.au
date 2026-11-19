import { render, screen, within } from "@testing-library/react";
import { investorBySlug } from "~/@/lib/ownership/australian-investors";
import { JsonLd } from "~/@/components/seo/json-ld";
import {
  investorPageMetadata,
  investorPageSchema,
} from "~/server/traders/profile-metadata";
import { TRADERS } from "~/@/lib/ownership/traders";
import { TraderPublicAccounts } from "../trader-public-accounts";
import {
  InvestorPhotoCredit,
  InvestorProfileHeader,
} from "../investor-profile-header";

function show(slug: string) {
  const trader = TRADERS.find((p) => p.slug === slug)!;
  const { container } = render(
    <>
      <JsonLd data={investorPageSchema(trader)} />
      <TraderPublicAccounts trader={trader} />
    </>,
  );
  const accounts = within(
    screen.getByRole("region", { name: "Public accounts" }),
  );
  const schema = JSON.parse(
    container.querySelector('script[type="application/ld+json"]')!.textContent!,
  ) as {
    mainEntity: {
      name: string;
      sameAs?: string[];
      image?: {
        contentUrl: string;
        creditText: string;
        license: string;
        isBasedOn: string;
      };
    };
    mentions?: { name: string; sameAs: string[] };
  };
  return { accounts, schema };
}

it("attributes a manager, a reporting firm and a co-hosted show to separate identities", () => {
  const { accounts, schema } = show("brad-gerstner");
  expect(schema.mainEntity.sameAs).toEqual([
    "https://www.linkedin.com/in/bradgerstner/",
    "https://x.com/altcap",
  ]);
  expect(schema.mentions).toMatchObject({
    name: "Altimeter Capital Management, LP",
    sameAs: ["https://www.linkedin.com/company/altimeter-capital/"],
  });
  expect(
    accounts.getByRole("link", {
      name: /YouTube @Bg2Pod · Co-hosted · BG2 Pod with Bill Gurley/,
    }),
  ).toHaveAttribute("href", "https://www.youtube.com/@Bg2Pod");
  expect(accounts.getByText("Account sources")).toBeInTheDocument();
});

it("distinguishes the chairman's LinkedIn from the firm's LinkedIn", () => {
  const { accounts } = show("geoff-wilson");
  expect(
    accounts.getByRole("link", { name: "LinkedIn · Geoff Wilson" }),
  ).toHaveAttribute(
    "href",
    "https://www.linkedin.com/in/geoff-wilson-6bb15a362/",
  );
  expect(
    accounts.getByRole("link", { name: "LinkedIn · Wilson Asset Management" }),
  ).toHaveAttribute(
    "href",
    "https://www.linkedin.com/company/wilson-asset-management/",
  );
});

it("links Burry's Substack author and X accounts without assigning a LinkedIn namesake", () => {
  const { accounts, schema } = show("michael-burry");
  expect(schema.mainEntity.sameAs).toEqual([
    "https://x.com/michaeljburry",
    "https://substack.com/@michaeljburry",
  ]);
  expect(accounts.queryByRole("link", { name: /LinkedIn/ })).toBeNull();
  expect(schema.mentions).toMatchObject({
    name: "Scion Asset Management, LLC",
    identifier: { propertyID: "SEC CIK", value: "0001649339" },
  });
  expect(schema.mainEntity).not.toHaveProperty("jobTitle");
  expect(schema.mentions?.sameAs).toBeUndefined();
});

it("shows the Australian firm when the founder's personal accounts are unresolved", () => {
  const { accounts, schema } = show("david-paradice");
  expect(accounts.getByText("No confirmed personal account.")).toBeVisible();
  expect(schema.mainEntity.sameAs).toBeUndefined();
  expect(schema.mentions?.sameAs).toEqual([
    "https://www.linkedin.com/company/paradice-investment-management-pty-ltd/",
  ]);
  expect(
    accounts.getByRole("link", {
      name: "LinkedIn · Paradice Investment Management",
    }),
  ).toHaveAttribute("href", schema.mentions?.sameAs[0]);
});

it("publishes the named portrait with its credit, original and reuse terms", () => {
  const { schema, accounts } = show("brad-gerstner");
  expect(schema.mainEntity.image).toMatchObject({
    contentUrl: "https://shorted.com.au/images/investors/brad-gerstner.webp",
    creditText: expect.stringMatching(/Boghosian/),
    license: expect.stringContaining("publicdomain"),
    isBasedOn: expect.stringContaining("Brad_Gerstner_at_the_White_House"),
  });
  expect(
    accounts.getByRole("link", {
      name: /Instagram @bg2pod · Co-hosted · BG2/i,
    }),
  ).toHaveAttribute("href", "https://www.instagram.com/bg2pod/");
  expect(schema.mainEntity.sameAs).not.toContain(
    "https://www.instagram.com/bg2pod/",
  );
});

it("links to the named publisher portrait for a person without a licensed local crop", () => {
  const person = TRADERS.find((p) => p.slug === "geoff-wilson")!;
  const { schema } = show(person.slug);
  render(
    <InvestorProfileHeader
      person={person}
      description={person.firm}
      crumbs={[
        { label: "Traders", href: "/ownership/traders" },
        { label: person.name, href: "/ownership/traders/geoff-wilson" },
      ]}
    />,
  );
  expect(
    screen.getByRole("link", {
      name: "Publisher portrait of Geoff Wilson at Wilson Asset Management",
    }),
  ).toHaveAttribute(
    "href",
    "https://wilsonassetmanagement.com.au/about-us/geoff-wilson-ao/",
  );
  expect(
    screen.getByRole("img", { name: "Portrait of Geoff Wilson" }),
  ).toHaveAttribute(
    "src",
    expect.stringContaining("wilsonassetmanagement.com.au/wp-content/"),
  );
  expect(schema.mainEntity.image).toBeUndefined();
});

it("keeps joint filers separate from organisations and their portraits", () => {
  const trader = { name: "Wesley and Emma Maas", slug: "wesley-and-emma-maas" };
  const { container } = render(<TraderPublicAccounts trader={trader} joint />);
  expect(
    container.querySelector('script[type="application/ld+json"]'),
  ).toBeNull();
  expect(
    screen.getByRole("link", {
      name: /Instagram @maasgroupholdings · Maas Group/,
    }),
  ).toBeVisible();
  expect(screen.queryByRole("link", { name: /Instagram .*Wesley/ })).toBeNull();
});

it("carries the original Australian attribution through to the public credit", () => {
  render(<InvestorPhotoCredit slug="gina-rinehart" />);
  expect(
    screen.getByRole("link", {
      name: /Department of Foreign Affairs and Trade website/,
    }),
  ).toHaveAttribute("href", "https://www.dfat.gov.au/");
  expect(screen.getByRole("link", { name: "CC BY 4.0" })).toHaveAttribute(
    "href",
    "https://creativecommons.org/licenses/by/4.0/",
  );
  expect(screen.getByText(/Cropped/)).toBeVisible();
});

it("lists each verified network under its owner with a visible platform name and handle", () => {
  const { accounts } = show("geoff-wilson");
  const personal = within(
    accounts.getByRole("list", { name: "Public links for Geoff Wilson" }),
  );
  const firm = within(
    accounts.getByRole("list", {
      name: "Public links for Wilson Asset Management",
    }),
  );
  const link = personal.getByRole("link", {
    name: "X (Twitter) @GeoffWilsonWAM · Geoff Wilson",
  });
  expect(within(link).getByText("X (Twitter)")).toBeVisible();
  expect(within(link).getByText("@GeoffWilsonWAM")).toBeVisible();
  expect(link).toHaveAttribute("href", "https://x.com/GeoffWilsonWAM");
  expect(
    firm.getByRole("link", {
      name: "X (Twitter) @WilsonAssetMgmt · Wilson Asset Management",
    }),
  ).toHaveAttribute("href", "https://x.com/WilsonAssetMgmt");
  expect(firm.getByText("@wilsonassetmanagement3863")).toBeVisible();
  expect(personal.queryByText("Facebook")).toBeNull();
});
it("shows the actual website domain on a website-only profile", () => {
  render(
    <TraderPublicAccounts
      trader={{ slug: "gina-rinehart", name: "Gina Rinehart" }}
    />,
  );
  const links = within(
    screen.getByRole("list", { name: "Public links for Gina Rinehart" }),
  ).getAllByRole("link");
  expect(links).toHaveLength(1);
  expect(links[0]).toHaveTextContent("Website");
  expect(links[0]).toHaveTextContent("ginarinehart.com.au");
  expect(links[0]).toHaveAttribute("href", "https://www.ginarinehart.com.au/");
});

it("describes named, no-account shareholders with the dated register and board source", () => {
  const brown = investorBySlug("hvn-christopher-herbert-brown")!;
  const schema = investorPageSchema(brown);
  expect(schema).toMatchObject({
    "@type": "ProfilePage",
    mainEntity: {
      name: "Christopher Herbert Brown",
      jobTitle: "Non-executive director",
      affiliation: { name: "Harvey Norman Holdings" },
    },
    citation: expect.arrayContaining([
      expect.objectContaining({ url: expect.stringContaining("#page=161") }),
      expect.objectContaining({
        url: expect.stringContaining("board-of-directors"),
      }),
    ]),
  });
  expect(brown.filings[0]?.filedName).toBe("Mr. Christopher Herbert Brown");
  expect(schema).not.toHaveProperty("mainEntity.sameAs");
  expect(investorPageSchema(investorBySlug("gina-rinehart")!)).toMatchObject({
    mainEntity: { alternateName: "Georgina Hope Rinehart" },
  });
  const meta = investorPageMetadata(brown);
  expect(meta.description).toMatch(/16\.495%.*26 Aug 2026/);
  expect(meta.openGraph).toMatchObject({
    type: "profile",
    images: [
      expect.objectContaining({
        url: expect.stringContaining(
          "hvn-christopher-herbert-brown/opengraph-image",
        ),
      }),
    ],
  });
});

it.each([
  ["wesley-and-emma-maas", ["Wesley Jon Maas", "Emma Margaret Maas"]],
  [
    "wtc-michael-and-suzanne-gregg",
    ["Michael John Gregg", "Suzanne Jane Gregg"],
  ],
])("identifies the two named filers separately on %s", (slug, names) => {
  const person = investorBySlug(slug as string)!;
  const schema = investorPageSchema(person);
  expect(schema).toMatchObject({
    "@type": "CollectionPage",
    about: (names as string[]).map((name) => ({ "@type": "Person", name })),
  });
  expect(schema).not.toHaveProperty("mainEntity");
  expect(investorPageMetadata(person).openGraph).toMatchObject({
    type: "website",
  });
});
