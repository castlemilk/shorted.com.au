import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowDown, ArrowLeft, ArrowUpRight } from "lucide-react";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { pageTitle } from "~/@/lib/typography";
import { portraits, publisherPortraits } from "~/server/traders/portraits";
import { publicAccounts } from "~/server/traders/public-accounts";
import { accountPlatforms } from "./account-platforms";

const actionLink =
  "inline-flex min-h-11 items-center gap-1.5 rounded-sm text-sm text-primary underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function InvestorProfileHeader({
  person,
  crumbs,
  description,
  children,
}: {
  person: { slug: string; name: string };
  crumbs: { label: string; href: string }[];
  description: string;
  children?: ReactNode;
}) {
  const parent = crumbs.at(-2)!;
  const photo = portraits[person.slug];
  const publisher = publisherPortraits[person.slug];
  const accounts = publicAccounts[person.slug];
  return (
    <>
      <div>
        <Breadcrumbs
          items={crumbs}
          prefetch={false}
          className="max-sm:hidden"
        />
        <nav aria-label="Parent section" className="sm:hidden">
          <Link
            href={parent.href}
            prefetch={false}
            className="inline-flex min-h-9 items-center gap-2 text-sm text-muted-foreground hover:text-primary"
          >
            <ArrowLeft aria-hidden="true" className="size-4" /> {parent.label}
          </Link>
        </nav>
      </div>
      <header className="min-w-0 border-b pb-3 [container:investor-header/inline-size] sm:pb-5">
        <div
          className={
            photo
              ? "grid min-w-0 flex-1 grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-x-4 sm:grid-cols-[7rem_minmax(0,1fr)] sm:grid-rows-[auto_1fr] sm:gap-x-6 [@container_investor-header_(max-width:13rem)]:grid-cols-1"
              : "min-w-0 flex-1"
          }
        >
          {photo && (
            <figure className="w-full max-w-[4.5rem] sm:row-span-2 sm:max-w-[7rem]">
              <a
                href="#portrait-credit"
                className="group block rounded-xl text-xs text-muted-foreground underline-offset-4 hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <Image
                  src={photo.image}
                  alt={`Portrait of ${person.name}`}
                  width={112}
                  height={140}
                  unoptimized
                  priority
                  className="aspect-[4/5] w-full rounded-xl border border-border object-cover"
                />
                <span className="mt-1 inline-block min-h-6 whitespace-nowrap group-hover:underline">
                  <span className="hidden sm:inline">Photo credit</span>
                  <span className="sm:hidden">Credit</span>
                </span>
              </a>
            </figure>
          )}
          <div className="min-w-0">
            <h1 className={`${pageTitle} [overflow-wrap:anywhere]`}>
              {person.name}
            </h1>
            <p className="mt-1 max-w-[64ch] text-sm leading-relaxed text-muted-foreground sm:text-base">
              {description}
            </p>
          </div>
          {(accounts ?? publisher ?? children) && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 max-sm:col-span-full sm:mt-3 sm:gap-x-5">
              {children}
              {accounts?.personal.map((account) => {
                const { label, Icon } = accountPlatforms[account.platform];
                return (
                  <a
                    key={account.url}
                    href={account.url}
                    aria-label={`${label} for ${person.name}${account.handle ? ` · ${account.handle}` : ""}`}
                    className={actionLink}
                  >
                    <Icon aria-hidden="true" className="size-4 shrink-0" />
                    {label}
                  </a>
                );
              })}
              {accounts && (
                <a
                  href="#public-accounts"
                  aria-label="Accounts and sources"
                  className={actionLink}
                >
                  Accounts <ArrowDown aria-hidden="true" className="size-3.5" />
                </a>
              )}
              {publisher && !photo && (
                <a
                  href={publisher.url}
                  aria-label={`Publisher portrait of ${person.name} at ${publisher.publisher}`}
                  className={actionLink}
                >
                  Publisher portrait{" "}
                  <ArrowUpRight aria-hidden="true" className="size-3.5" />
                </a>
              )}
            </div>
          )}
        </div>
      </header>
    </>
  );
}

export function InvestorPhotoCredit({ slug }: { slug: string }) {
  const photo = portraits[slug];
  if (!photo) return null;
  const link =
    "text-primary underline underline-offset-4";
  return (
    <footer
      id="portrait-credit"
      tabIndex={-1}
      className="scroll-mt-32 space-y-1 border-t pt-3 text-xs leading-relaxed text-muted-foreground"
    >
      <p className="font-medium text-foreground">Photograph · {photo.year}</p>
      <p>
        <a href={photo.creditUrl} className={link}>
          {photo.credit}
        </a>
      </p>
      <p>
        <a href={photo.source} className={link}>
          Original photograph
        </a>
        {" · "}
        <a href={photo.licenseUrl} className={link}>
          {photo.license}
        </a>
        {" · Cropped"}
      </p>
    </footer>
  );
}
