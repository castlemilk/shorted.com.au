import { ArrowUpRight } from "lucide-react";
import { accountPlatforms } from "./account-platforms";
import { JsonLd } from "~/@/components/seo/json-ld";
import { traderHref, type TraderProfile } from "~/@/lib/ownership/traders";
import { sectionTitle } from "~/@/lib/typography";
import {
  publicAccounts,
  type PublicAccount,
} from "~/server/traders/public-accounts";
import { portraits } from "~/server/traders/portraits";
import snapshot from "~/server/traders/account-crawl.json";

const checks: Record<string, { status: string; links?: string[] } | undefined> =
  snapshot.pages;
const access: Record<string, string> = {
  responded: "Page responded",
  restricted: "Automated access restricted",
  missing: "Page returned not found",
  unavailable: "Page unavailable during check",
  document: "Document responded",
};

const checkedDate = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const link =
  "text-primary underline underline-offset-4 hover:decoration-2";

export function TraderPublicAccounts({
  trader,
  path = traderHref(trader),
  joint = false,
}: {
  trader: Pick<TraderProfile, "slug" | "name"> & { firm?: string };
  path?: string;
  joint?: boolean;
}) {
  const accounts = publicAccounts[trader.slug];
  const personal = accounts?.personal ?? [];
  const firm = accounts?.firm;
  const firmName = accounts?.organization ?? trader.firm;
  const coHosted = accounts?.coHosted;
  const groups = [
    ...(!joint || personal.length
      ? [{ name: trader.name, accounts: personal }]
      : []),
    ...(firm?.length ? [{ name: firmName, accounts: firm }] : []),
    ...(coHosted
      ? [{ name: `Co-hosted · ${coHosted.name}`, accounts: coHosted.accounts }]
      : []),
  ];
  const sources = new Map<
    string,
    { title: string; attributions: { label: string; account: PublicAccount }[] }
  >();
  for (const group of groups) {
    for (const account of group.accounts) {
      const { platform, source } = account;
      const attribution = {
        label: `${group.name} · ${accountPlatforms[platform].label}`,
        account,
      };
      const existing = sources.get(source.url);
      if (existing) {
        existing.attributions.push(attribution);
      } else {
        sources.set(source.url, {
          title: source.title,
          attributions: [attribution],
        });
      }
    }
  }
  const url = `https://shorted.com.au${path}`;
  const portrait = portraits[trader.slug];
  return (
    <section
      id="public-accounts"
      aria-labelledby="public-accounts-title"
      tabIndex={-1}
      className="scroll-mt-32 space-y-4"
    >
      {!joint && (
        <JsonLd
          data={{
            "@context": "https://schema.org",
            "@type": "ProfilePage",
            url,
            mainEntity: {
              "@type": "Person",
              name: trader.name,
              url,
              ...(portrait
                ? {
                    image: {
                      "@type": "ImageObject",
                      contentUrl: `https://shorted.com.au${portrait.image}`,
                      creditText: portrait.credit,
                      license: portrait.licenseUrl,
                      isBasedOn: portrait.source,
                    },
                  }
                : {}),
              ...(personal.length
                ? { sameAs: personal.map((a) => a.url) }
                : {}),
            },
            ...(firm?.length
              ? {
                  mentions: {
                    "@type": "Organization",
                    name: firmName,
                    sameAs: firm.map((a) => a.url),
                  },
                }
              : {}),
          }}
        />
      )}
      <h2 id="public-accounts-title" className={sectionTitle}>
        Public accounts
      </h2>
      <dl className="space-y-5 text-sm">
        {groups.map((group) => (
          <div key={group.name}>
            <dt className="font-semibold leading-snug">{group.name}</dt>
            <dd className="mt-1">
              {group.accounts.length ? (
                <ul
                  aria-label={`Public links for ${group.name}`}
                  className="divide-y divide-border/65"
                >
                  {group.accounts.map((account) => {
                    const { label, Icon } = accountPlatforms[account.platform];
                    const detail =
                      account.platform === "Official website"
                        ? new URL(account.url).hostname.replace(/^www\./, "")
                        : account.handle;
                    return (
                      <li key={account.url}>
                        <a
                          href={account.url}
                          aria-label={`${label}${detail ? ` ${detail}` : ""} · ${group.name}`}
                          className="group grid min-h-11 grid-cols-[1rem_minmax(0,1fr)_0.875rem] items-center gap-x-2.5 rounded-sm py-1.5 hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          <Icon
                            aria-hidden="true"
                            className="size-4 text-primary"
                          />
                          <span className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                            <span className="font-medium text-foreground underline-offset-4 group-hover:text-primary group-hover:underline">
                              {label}
                            </span>{" "}
                            {detail && (
                              <span className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                                {detail}
                              </span>
                            )}
                          </span>
                          <ArrowUpRight
                            aria-hidden="true"
                            className="size-3.5 text-muted-foreground group-hover:text-primary"
                          />
                        </a>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <span className="text-muted-foreground">
                  No confirmed personal account.
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {accounts && (
        <details className="border-t text-xs text-muted-foreground">
          <summary className="min-h-10 cursor-pointer py-3 font-medium text-foreground">
            Account sources
          </summary>
          <p className="mt-2">
            Checked by editors{" "}
            <time dateTime={accounts.reviewedOn}>
              {checkedDate.format(new Date(accounts.reviewedOn))}
            </time>
          </p>
          <p>
            Public link check{" "}
            <time dateTime={snapshot.checkedOn}>
              {checkedDate.format(new Date(snapshot.checkedOn))}
            </time>
          </p>
          <ul className="mt-2 space-y-2">
            {Array.from(sources, ([href, source]) => (
              <li key={href}>
                <a className={link} href={href}>
                  {source.title}
                </a>
                <ul className="mt-1 space-y-1">
                  {source.attributions.map(({ label, account }) => {
                    const destination = checks[account.url];
                    const linked = checks[href]?.links?.includes(account.url);
                    return (
                      <li key={account.url}>
                        <span className="block">{label}</span>
                        <span>
                          {[
                            linked && "Linked by source",
                            destination && access[destination.status],
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
