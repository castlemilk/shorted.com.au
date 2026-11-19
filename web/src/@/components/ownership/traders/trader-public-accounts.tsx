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
  "text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary";

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
      const attribution = { label: `${group.name} · ${platform}`, account };
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
      className="scroll-mt-32 space-y-3 border-t pt-3"
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
      <dl className="space-y-3 text-sm">
        {groups.map((group) => (
          <div key={group.name}>
            <dt className="font-medium">{group.name}</dt>
            <dd className="mt-1">
              {group.accounts.length ? (
                <ul className="flex flex-wrap items-center gap-x-4">
                  {group.accounts.map((a) => (
                    <li key={a.url}>
                      <a
                        className={`inline-flex min-h-10 items-center ${link}`}
                        href={a.url}
                        aria-label={`${a.platform} · ${group.name}${a.handle ? ` · ${a.handle}` : ""}`}
                      >
                        {a.platform}
                        {a.handle && ` · ${a.handle}`}
                      </a>
                    </li>
                  ))}
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
