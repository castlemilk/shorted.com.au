import { render, screen, within } from "@testing-library/react";
import { TRADERS } from "~/@/lib/ownership/traders";
import { TraderPublicAccounts } from "../trader-public-accounts";
import {
  InvestorPhotoCredit,
  InvestorProfileHeader,
} from "../investor-profile-header";

function show(slug: string) {
  const trader = TRADERS.find((p) => p.slug === slug)!;
  const { container } = render(<TraderPublicAccounts trader={trader} />);
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
      name: /YouTube · Co-hosted · BG2 Pod with Bill Gurley/,
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
  expect(schema.mentions).toBeUndefined();
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
    accounts.getByRole("link", { name: /Instagram · Co-hosted · BG2/ }),
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
      name: "Portrait of Geoff Wilson at Wilson Asset Management",
    }),
  ).toHaveAttribute(
    "href",
    "https://wilsonassetmanagement.com.au/about-us/geoff-wilson-ao/",
  );
  expect(screen.queryByRole("img", { name: /Portrait/ })).toBeNull();
  expect(schema.mainEntity.image).toBeUndefined();
});

it("keeps joint filers separate from organisations and their portraits", () => {
  const trader = { name: "Wesley and Emma Maas", slug: "wesley-and-emma-maas" };
  const { container } = render(
    <TraderPublicAccounts
      trader={trader}
      path="/ownership/traders/australia/wesley-and-emma-maas"
      joint
    />,
  );
  expect(
    container.querySelector('script[type="application/ld+json"]'),
  ).toBeNull();
  expect(
    screen.getByRole("link", { name: /Instagram · Maas Group/ }),
  ).toBeVisible();
  expect(screen.queryByRole("link", { name: /Instagram · Wesley/ })).toBeNull();
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
    name: "X (Twitter) · Geoff Wilson · @GeoffWilsonWAM",
  });
  expect(within(link).getByText("X (Twitter)")).toBeVisible();
  expect(within(link).getByText("@GeoffWilsonWAM")).toBeVisible();
  expect(link).toHaveAttribute("href", "https://x.com/GeoffWilsonWAM");
  expect(
    firm.getByRole("link", { name: /X \(Twitter\) · Wilson Asset Management/ }),
  ).toHaveAttribute("href", "https://x.com/WilsonAssetMgmt");
  expect(firm.getByText("@wilsonassetmanagement3863")).toBeVisible();
  expect(personal.queryByText("Facebook")).toBeNull();
});
it("shows the actual website domain on a website-only profile", () => {
  render(
    <TraderPublicAccounts
      trader={{ slug: "gina-rinehart", name: "Gina Rinehart" }}
      path="/ownership/traders/australia/gina-rinehart"
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
