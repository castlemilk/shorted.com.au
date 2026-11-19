import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { NamedFilerRegister } from "~/@/components/ownership/traders/named-filer-register";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { AUSTRALIAN_INVESTORS_PATH } from "~/@/lib/ownership/australian-investors";
import { disclosureRow } from "~/@/lib/ownership/investor-disclosures";
import { filerPath } from "~/@/lib/ownership/named-filer";
import { REGISTER_CODE_PATTERN } from "~/@/lib/ownership/kinds";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import { lede, pageTitle } from "~/@/lib/typography";
import { bailOnEmptyRender } from "~/app/actions/config";
import {
  readRegister,
  isUnknownRegister,
  registerCompany,
} from "~/app/ownership/stocks/[code]/register-data";

export const revalidate = 3600;
export const dynamicParams = true;
export function generateStaticParams(): Array<{ code: string }> {
  return [];
}

type Props = { params: Promise<{ code: string }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const code = (await params).code.toUpperCase();
  if (!REGISTER_CODE_PATTERN.test(code)) notFound();
  return {
    title: `${code} substantial holding filers`,
    alternates: { canonical: `https://shorted.com.au${filerPath(code)}` },
    robots: { index: false, follow: true },
  };
}
export default async function FiledNamesPage({ params }: Props) {
  const code = (await params).code.toUpperCase();
  if (!REGISTER_CODE_PATTERN.test(code)) notFound();
  const data = await readRegister(code);
  if (isUnknownRegister(data)) notFound();
  if (!data.asOf) await bailOnEmptyRender();
  return (
    <DashboardLayout>
      <div className="mx-auto min-w-0 max-w-6xl space-y-6">
        <Breadcrumbs
          items={[
            { label: "Ownership", href: "/ownership" },
            { label: "Australian investors", href: AUSTRALIAN_INVESTORS_PATH },
            { label: `${code} filers`, href: filerPath(code) },
          ]}
          prefetch={false}
        />
        <header>
          <h1 className={pageTitle}>{code} substantial holding filers</h1>
          <p className={lede}>
            Follow a filing name at {registerCompany(code, data)}. A filer can
            be a person, a group or a company.
            {data.asOf && ` Register read to ${data.asOf}.`}
          </p>
        </header>
        {data.asOf ? (
          <NamedFilerRegister
            code={code}
            current={data.holders.map((h) => ({
              name: h.holderName,
              pct: h.votingPowerPct,
              date: h.announcedOn,
              source: safeExternalHref(h.announcementUrl),
            }))}
            history={data.history.map(disclosureRow)}
            limited={data.historyTotal > data.history.length}
          />
        ) : (
          <p>The issuer register is temporarily unavailable.</p>
        )}
      </div>
    </DashboardLayout>
  );
}
