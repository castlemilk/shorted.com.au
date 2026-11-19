import { JsonLd } from "~/@/components/seo/json-ld";
import { traderHref, type TraderProfile } from "~/@/lib/ownership/traders";
import { eyebrow } from "~/@/lib/typography";
import { publicAccounts } from "~/server/traders/public-accounts";

const checkedDate = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const link =
  "text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary";

export function TraderPublicAccounts({ trader }: { trader: TraderProfile }) {
  const accounts = publicAccounts[trader.slug];
  const personal = accounts?.personal ?? [];
  const firm = accounts?.firm;
  const coHosted = accounts?.coHosted;
  const groups = [
    { name: trader.name, accounts: personal },
    ...(firm?.length ? [{ name: trader.firm, accounts: firm }] : []),
    ...(coHosted
      ? [{ name: `Co-hosted · ${coHosted.name}`, accounts: coHosted.accounts }]
      : []),
  ];
  const url = `https://shorted.com.au${traderHref(trader)}`;
  return (
    <section
      id="public-accounts"
      aria-labelledby="public-accounts-title"
      className="scroll-mt-28 space-y-3 border-t pt-3"
    >
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "ProfilePage",
          url,
          mainEntity: {
            "@type": "Person",
            name: trader.name,
            url,
            ...(personal.length ? { sameAs: personal.map((a) => a.url) } : {}),
          },
          ...(firm?.length
            ? {
                mentions: {
                  "@type": "Organization",
                  name: trader.firm,
                  sameAs: firm.map((a) => a.url),
                },
              }
            : {}),
        }}
      />
      <h2 id="public-accounts-title" className={eyebrow}>
        Public accounts
      </h2>
      <dl className="space-y-3 text-sm">
        {groups.map((group) => (
          <div key={group.name}>
            <dt className="font-medium">{group.name}</dt>
            <dd className="mt-1">
              {group.accounts.length ? (
                <ul className="flex flex-wrap gap-x-4 gap-y-1">
                  {group.accounts.map((a) => (
                    <li key={a.url}>
                      <a
                        className={link}
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
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Account sources</summary>
          <p className="mt-2">
            Checked{" "}
            <time dateTime={accounts.reviewedOn}>
              {checkedDate.format(new Date(accounts.reviewedOn))}
            </time>
          </p>
          <ul className="mt-2 space-y-2">
            {groups.flatMap((group) =>
              group.accounts.map((a) => (
                <li key={a.url}>
                  <span className="block">
                    {group.name} · {a.platform}
                  </span>
                  <a className={link} href={a.source.url}>
                    {a.source.title}
                  </a>
                </li>
              )),
            )}
          </ul>
        </details>
      )}
    </section>
  );
}
