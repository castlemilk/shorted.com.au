import Link from "next/link";
import {
  type annualInterestsForInvestor,
  investorPct,
} from "~/@/lib/ownership/australian-investors";
import { registerHref } from "~/@/lib/ownership/kinds";
import { sectionTitle } from "~/@/lib/typography";
import { formatIsoDate } from "~/@/lib/strategies/format";

const link = "text-primary underline underline-offset-4 hover:decoration-2";

export function AnnualInterests({
  entries,
  description,
}: {
  entries: ReturnType<typeof annualInterestsForInvestor>;
  description?: string;
}) {
  return (
    <section
      aria-labelledby="annual-interest-title"
      className="min-w-0 space-y-3"
    >
      <h2 id="annual-interest-title" className={sectionTitle}>
        Substantial interests in annual reports
      </h2>
      {description && (
        <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
      )}
      {entries.map(({ code, company, date, page, amount, holder, source }) => (
        <div key={source} className="min-w-0 border-y py-3.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
            <Link
              prefetch={false}
              href={registerHref(code)}
              className={`text-sm font-medium ${link}`}
            >
              {code} · {company}
            </Link>
            <span className="text-xs text-muted-foreground">
              Register at{" "}
              <time dateTime={date} className="whitespace-nowrap">
                {formatIsoDate(date)}
              </time>
            </span>
          </div>
          <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
            {amount.shares !== undefined && (
              <div>
                <dt className="text-xs text-muted-foreground">
                  Ordinary shares reported
                </dt>
                <dd className="mt-1 text-xl font-semibold tabular-nums sm:text-2xl">
                  {amount.shares.toLocaleString("en-AU")}
                </dd>
              </div>
            )}
            {amount.pct !== undefined && (
              <div>
                <dt className="text-xs text-muted-foreground">
                  Reported interest
                </dt>
                <dd className="mt-1 text-xl font-semibold tabular-nums sm:text-2xl">
                  {investorPct(amount.pct)}
                  <span
                    aria-hidden="true"
                    className="mt-1.5 block h-[3px] w-28 bg-border"
                  >
                    <span
                      className="block h-full bg-primary"
                      style={{ width: `${amount.pct}%` }}
                    />
                  </span>
                </dd>
              </div>
            )}
          </dl>
          <p className="mt-3 max-w-3xl text-pretty text-sm">
            <span className="text-muted-foreground">Listed under </span>
            {holder}
          </p>
          <a
            href={source}
            className={`mt-1 inline-flex min-h-8 items-center text-xs ${link}`}
          >
            Annual report · p. {page}
          </a>
        </div>
      ))}
    </section>
  );
}
