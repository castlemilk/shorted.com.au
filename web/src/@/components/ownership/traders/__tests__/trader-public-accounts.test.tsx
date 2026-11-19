import { render, screen, within } from "@testing-library/react";
import { TRADERS } from "~/@/lib/ownership/traders";
import { TraderPublicAccounts } from "../trader-public-accounts";

function show(slug: string) {
  const trader = TRADERS.find((p) => p.slug === slug)!;
  const { container } = render(<TraderPublicAccounts trader={trader} />);
  const accounts = within(
    screen.getByRole("region", { name: "Public accounts" }),
  );
  const schema = JSON.parse(
    container.querySelector('script[type="application/ld+json"]')!.textContent!,
  ) as {
    mainEntity: { name: string; sameAs?: string[] };
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
