import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { GraphIndex } from "~/@/components/ownership/graph/graph-index";
import { GraphSearch } from "~/@/components/ownership/graph/graph-search";
import { OwnershipPaths } from "~/@/components/ownership/graph/ownership-paths";
import { InvestorThumbnail } from "~/@/components/ownership/traders/investor-thumbnail";
import { graphHref, GRAPH_PATH } from "~/@/lib/ownership/graph-links";
import {
  investorBySlug,
  investorHref,
  investorPct,
} from "~/@/lib/ownership/australian-investors";
import {
  currentFilerRow,
  disclosureRow,
} from "~/@/lib/ownership/investor-disclosures";
import {
  registerHref,
  fundHref,
  institutionHref,
  isInstitutionSlug,
  REGISTER_CODE_PATTERN,
} from "~/@/lib/ownership/kinds";
import {
  directorHref,
  directorKey,
  isNamedDirectorTrade,
  DIRECTOR_READ_LIMIT,
  traderHref,
  tradersForHolder,
  TRADERS,
} from "~/@/lib/ownership/traders";
import { stockTabHref } from "~/@/lib/stocks/stock-tabs";
import { pageTitle, sectionTitle } from "~/@/lib/typography";
import {
  getStockOwnership,
  getInstitutionOrNotFound,
  listInstitutions,
} from "~/app/actions/getOwnership";
import { NotFoundError } from "~/app/actions/withRetry";
import {
  graphRows,
  graphSearchItems,
  graphNodeLabel,
  localGraphNode,
  graphFilerNode,
  scopedAccount,
  issuerOfAccount,
} from "~/server/traders/ownership-graph";
import { getDirectorTrades } from "~/app/actions/getDirectorTrades";
import { bailOnEmptyRender } from "~/app/actions/config";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import type { DirectorTrade } from "~/gen/shorts/v1alpha1/stock_pb";
import { formatIsoDate } from "~/@/lib/strategies/format";
import { isUnknownRegister } from "../../../stocks/[code]/register-data";

export const revalidate = 3600;
export const dynamicParams = true;
export function generateStaticParams(): Array<{ node: string[] }> {
  return [];
}
type Props = { params: Promise<{ node?: string[] }> };
const link =
  "inline-flex min-h-10 items-center gap-1 text-sm text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary";
const asxManagers = TRADERS.filter((t) => t.reporting.market === "ASX");

const load = cache(async (kind: string, id: string) => {
  let focus = localGraphNode(kind, id);
  const validCompany = kind === "company" && REGISTER_CODE_PATTERN.test(id);
  const validInstitution = kind === "institution" && isInstitutionSlug(id);
  const manager =
    kind === "person" ? asxManagers.find((p) => p.slug === id) : undefined;
  const accountIssuer = kind === "account" ? issuerOfAccount(id) : undefined;
  const registerCode = validCompany ? id : accountIssuer;
  if (
    !accountIssuer &&
    !focus &&
    !validCompany &&
    !validInstitution &&
    !manager
  )
    notFound();
  const [stock, directors] = registerCode
    ? await Promise.all([
        getStockOwnership(registerCode),
        validCompany ? getDirectorTrades(id, DIRECTOR_READ_LIMIT) : undefined,
      ])
    : [];
  if (registerCode && (!stock?.summary || (validCompany && !directors)))
    await bailOnEmptyRender();
  if (validCompany && !focus) {
    if (!stock?.summary)
      throw Error("Company register is temporarily unavailable");
    if (isUnknownRegister({ ...stock, summary: stock.summary })) notFound();
    focus = { kind: "company", id, name: stock.summary.companyName || id };
  }
  if (accountIssuer && !focus) {
    if (!stock?.summary)
      throw Error("Filing register is temporarily unavailable");
    const reported = [...stock.holders, ...stock.history].find(
      (row) => scopedAccount(accountIssuer, row.holderName).id === id,
    );
    if (!reported) notFound();
    focus = scopedAccount(accountIssuer, reported.holderName);
  }
  let institution;
  if (validInstitution) {
    try {
      institution = await getInstitutionOrNotFound(id);
    } catch (e) {
      if (e instanceof NotFoundError) notFound();
      throw e;
    }
    if (!institution?.institution)
      throw Error("Institution register is temporarily unavailable");
    focus = { kind: "institution", id, name: institution.institution.name };
  }
  if (manager) focus = { kind: "person", id: manager.slug, name: manager.name };
  if (!focus) notFound();
  return { focus, stock, institution, manager, directors };
});
async function read(params: Props["params"]) {
  const { node } = await params;
  if (!node?.length) notFound();
  if (node.length !== 2 || !node[0] || !node[1] || node[1].length > 150)
    notFound();
  const [kind, id] = node as [string, string];
  if (kind === "company" && id !== id.toUpperCase())
    redirect(graphHref("company", id.toUpperCase()));
  return load(kind, id);
}
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  if (!(await params).node?.length)
    return {
      title: "Australian ownership graph",
      alternates: { canonical: "https://shorted.com.au" + GRAPH_PATH },
    };
  const { focus } = await read(params);
  return {
    title: focus.name + " ownership graph",
    alternates: {
      canonical: "https://shorted.com.au" + graphHref(focus.kind, focus.id),
    },
  };
}

type Connection = {
  name: string;
  href: string;
  detail: string;
  source?: string | null;
  document?: string;
  date?: string;
  key: string;
  personSlug?: string;
};
function directorConnections(
  code: string,
  trades: DirectorTrade[],
): Connection[] {
  const rows = new Map<string, Connection>();
  for (const t of trades.filter(isNamedDirectorTrade)) {
    const name = t.directorName.trim(),
      key = directorKey(name),
      date = t.tradeDate.slice(0, 10);
    if (rows.has(key) && (rows.get(key)?.date ?? "") >= date) continue;
    const action =
      t.tradeType === "buy"
        ? "Acquisition"
        : t.tradeType === "sell"
          ? "Disposal"
          : t.tradeType === "exercise_options"
            ? "Option exercise"
            : "Change of interest";
    rows.set(key, {
      name,
      key,
      href: directorHref(code, name),
      detail:
        action + " · " + t.sharesTraded.toLocaleString("en-AU") + " units",
      date,
      source: safeExternalHref(t.announcementUrl),
      document: "Director filing",
    });
  }
  return [...rows.values()].sort(
    (a, b) =>
      (b.date ?? "").localeCompare(a.date ?? "") ||
      a.name.localeCompare(b.name),
  );
}
function ConnectionList({
  title,
  rows,
}: {
  title: string;
  rows: Connection[];
}) {
  if (!rows.length) return null;
  const render = (r: Connection) => (
    <li
      key={r.key}
      className="grid min-w-0 items-baseline gap-x-4 gap-y-1 border-t py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
    >
      <Link
        prefetch={false}
        href={r.href}
        className="inline-flex min-w-0 items-center gap-2 break-words text-sm font-medium hover:text-primary hover:underline"
      >
        {r.personSlug && (
          <InvestorThumbnail slug={r.personSlug} size="directory" />
        )}
        {r.name}
      </Link>
      <span className="min-w-0 break-words text-xs text-muted-foreground">
        {r.detail}
      </span>
      <span className="flex flex-wrap items-baseline gap-x-3 text-xs">
        {r.date && <time dateTime={r.date}>{formatIsoDate(r.date)}</time>}
        {r.source && (
          <a
            href={r.source}
            className="text-primary underline underline-offset-4"
          >
            {r.document ?? "Source"} ↗
          </a>
        )}
      </span>
    </li>
  );
  return (
    <section aria-label={title} className="min-w-0 space-y-2">
      <h2 className={sectionTitle}>{title}</h2>
      <ul>{rows.slice(0, 6).map(render)}</ul>
      {rows.length > 6 && (
        <details className="border-t text-sm">
          <summary className="cursor-pointer py-2 text-primary">
            Show {rows.length - 6} more
          </summary>
          <ul>{rows.slice(6).map(render)}</ul>
        </details>
      )}
    </section>
  );
}
export default async function OwnershipGraphPage({ params }: Props) {
  if (!(await params).node?.length) return <GraphIndex />;
  const [{ focus, stock, institution, manager, directors }, directory] =
    await Promise.all([read(params), listInstitutions("", "", 200, 0)]);
  const rows = graphRows(focus);
  const profile =
    focus.kind === "person" ? investorBySlug(focus.id) : undefined;
  const stockCode = focus.kind === "company" ? focus.id : "";
  const institutions: Connection[] = [];
  const accountIssuer =
    focus.kind === "account" ? issuerOfAccount(focus.id) : undefined;
  const positions =
    institution?.positions ?? (stockCode ? stock?.holders : undefined) ?? [];
  for (const h of positions) {
    const notice = currentFilerRow(h);
    const filer =
      graphFilerNode(h.stockCode, h.holderName) ??
      scopedAccount(h.stockCode, h.holderName);
    const target = institution
      ? graphHref("company", h.stockCode)
      : h.institutionSlug
        ? graphHref("institution", h.institutionSlug)
        : graphHref(filer.kind, filer.id);
    institutions.push({
      key: h.holderKey + "/" + h.holderName + "/" + h.stockCode,
      name:
        focus.kind === "institution"
          ? h.companyName || h.stockCode
          : h.holderName,
      href: target,
      detail:
        h.stockCode +
        " · " +
        (notice.pct == null
          ? "Voting power unstated"
          : investorPct(notice.pct) + " voting power"),
      source: notice.source,
      document: "Form " + notice.form,
      date: notice.date,
    });
  }
  const history: Connection[] = accountIssuer
    ? (stock?.history ?? [])
        .filter(
          (n) => scopedAccount(accountIssuer, n.holderName).id === focus.id,
        )
        .map((n) => {
          const notice = disclosureRow(n);
          return {
            name: n.companyName || accountIssuer,
            key: n.announcementUrl + "/" + n.announcedOn + "/" + n.form,
            href: graphHref("company", accountIssuer),
            detail: notice.ceased
              ? "Ceased to be substantial"
              : notice.pct != null
                ? investorPct(notice.pct) + " voting power"
                : "Voting power unstated",
            date: notice.date,
            source: notice.source,
            document: "Form " + notice.form,
          };
        })
    : [];
  // A current holder can outlive the notice window returned by this register.
  if (accountIssuer && !history.length)
    for (const h of stock?.holders ?? []) {
      if (scopedAccount(accountIssuer, h.holderName).id !== focus.id) continue;
      const n = currentFilerRow(h);
      history.push({
        name: h.companyName || accountIssuer,
        key: h.holderKey,
        href: graphHref("company", accountIssuer),
        detail:
          n.pct == null
            ? "Voting power unstated"
            : investorPct(n.pct) + " voting power",
        date: n.date,
        source: n.source,
        document: "Form " + n.form,
      });
    }
  const fundFiles: Connection[] = (stockCode ? (stock?.fundHoldings ?? []) : [])
    .filter((f) => !!f.institutionSlug)
    .map((f) => ({
      key:
        f.institutionSlug +
        "/" +
        f.sourceKind +
        "/" +
        f.fundName +
        "/" +
        f.asAt,
      href: graphHref("institution", f.institutionSlug),
      name: f.institutionName || f.institutionSlug,
      detail:
        f.fundName +
        (f.hasUnits ? " · " + f.units.toLocaleString("en-AU") + " units" : ""),
      date: f.asAt,
      source: registerHref(stockCode) + "#funds",
      document: "Register",
    }));
  const relatedManagers =
    focus.kind === "institution" ? tradersForHolder(focus.id) : [];
  const managed: Connection[] =
    manager?.reporting.market === "ASX"
      ? [
          {
            name: manager.firm,
            href: graphHref("institution", manager.reporting.holder),
            key: manager.reporting.holder,
            detail: manager.role,
            source: manager.roleSource,
            document: "Role source",
          },
        ]
      : [];
  const relatedPeople = relatedManagers.map((t) => ({
    name: t.name,
    key: t.slug,
    personSlug: t.slug,
    href: graphHref("person", t.slug),
    detail: t.role,
    source: t.roleSource,
    document: "Role source",
  }));
  const funds = (institution?.funds ?? [])
    .filter((f) => !!f.fundKey)
    .map((f) => ({
      name: f.name,
      key: f.fundKey,
      href: fundHref(f.fundKey),
      detail: f.asxCode || f.managerName || f.fundType.replaceAll("_", " "),
      date: f.asAt,
    }));
  const directorRows = directorConnections(stockCode, directors?.trades ?? []);
  const self = graphHref(focus.kind, focus.id);
  const caption =
    profile?.description ??
    (focus.kind === "organisation"
      ? "The filings below name this organisation in the reported interests."
      : focus.kind === "account"
        ? undefined
        : manager
          ? manager.role + " · " + manager.firm
          : focus.kind === "institution"
            ? institution?.institution?.description
            : undefined);
  const searchItems = [...graphSearchItems];
  const seen = new Set(searchItems.map((i) => i.href));
  for (const inst of directory?.institutions ?? []) {
    const href = graphHref("institution", inst.slug);
    if (!seen.has(href)) {
      searchItems.push({ name: inst.name, href, detail: "Institution" });
      seen.add(href);
    }
  }
  for (const r of [...institutions, ...fundFiles, ...relatedPeople, ...managed])
    if (r.href.startsWith(GRAPH_PATH + "/") && !seen.has(r.href)) {
      searchItems.push({ name: r.name, href: r.href, detail: r.detail });
      seen.add(r.href);
    }
  return (
    <DashboardLayout fullWidth>
      <div className="mx-auto w-full min-w-0 max-w-[90rem] space-y-4 px-0 sm:space-y-5">
        <Link
          href={GRAPH_PATH}
          prefetch={false}
          className="inline-flex min-h-8 items-center gap-1 text-sm text-muted-foreground sm:hidden"
        >
          ← Ownership graph
        </Link>
        <Breadcrumbs
          className="max-sm:hidden"
          prefetch={false}
          items={[
            { label: "Ownership", href: "/ownership" },
            { label: "Connections", href: "/ownership/connections" },
            { label: "Ownership graph", href: GRAPH_PATH },
            { label: focus.name, href: self },
          ]}
        />
        <header className="grid items-end gap-x-6 gap-y-3 sm:grid-cols-[minmax(0,1fr)_minmax(14rem,22rem)]">
          <div className="flex min-w-0 items-center gap-3 sm:gap-5">
            {focus.kind === "person" && (
              <InvestorThumbnail slug={focus.id} size="focus" />
            )}
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">
                {graphNodeLabel[focus.kind]}
                {stockCode || accountIssuer
                  ? " · ASX:" + (stockCode || accountIssuer)
                  : ""}
              </p>
              <h1 className={pageTitle + " mt-1 break-words"}>{focus.name}</h1>
            </div>
          </div>
          <GraphSearch key={self} items={searchItems} />
        </header>
        <div className="space-y-1">
          {caption && (
            <p className="max-w-[85ch] text-pretty text-sm text-muted-foreground">
              {caption}
            </p>
          )}
          <nav aria-label="Related records" className="flex flex-wrap gap-x-5">
            {stockCode && (
              <>
                <Link
                  className={link}
                  prefetch={false}
                  aria-label="Company profile"
                  href={stockTabHref(stockCode, "company")}
                >
                  Company<span className="hidden sm:contents"> profile</span>
                </Link>
                <Link
                  className={link}
                  prefetch={false}
                  aria-label="Ownership register"
                  href={registerHref(stockCode)}
                >
                  <span className="hidden sm:contents">Ownership register</span>
                  <span className="sm:hidden">Register</span>
                </Link>
                <Link
                  className={link}
                  prefetch={false}
                  href={directorHref(stockCode)}
                >
                  Director filings
                </Link>
              </>
            )}
            {accountIssuer && (
              <Link
                href={graphHref("company", accountIssuer)}
                prefetch={false}
                className={link}
              >
                ASX:{accountIssuer} ownership graph
              </Link>
            )}
            {(profile ?? manager) && (
              <Link
                className={link}
                prefetch={false}
                href={
                  profile ? investorHref(profile.slug) : traderHref(manager!)
                }
              >
                Investor profile
              </Link>
            )}
            {focus.kind === "institution" && (
              <Link
                className={link}
                prefetch={false}
                href={institutionHref(focus.id)!}
              >
                Institution profile
              </Link>
            )}
            {rows[0] &&
              (focus.kind === "account" || focus.kind === "organisation") && (
                <a href={rows[0].identitySource} className={link}>
                  Identity source{" "}
                  <ArrowUpRight aria-hidden="true" className="size-3" />
                </a>
              )}
          </nav>
        </div>
        {rows.length > 0 && <OwnershipPaths focus={focus} rows={rows} />}
        <ConnectionList
          title="People at this institution"
          rows={relatedPeople}
        />
        <ConnectionList title="Notices for this filed name" rows={history} />
        <ConnectionList title="Reporting institution" rows={managed} />
        <ConnectionList
          title={
            institution
              ? "Companies in holding notices"
              : "Substantial holding notices"
          }
          rows={institutions}
        />
        <ConnectionList
          title="Directors named in interest changes"
          rows={directorRows}
        />
        <ConnectionList
          title="Fund managers reporting this stock"
          rows={fundFiles}
        />
        <ConnectionList title="Investment products" rows={funds} />
        {stockCode && !directors && (
          <p role="status" className="text-sm text-muted-foreground">
            Director filings are temporarily unavailable.
          </p>
        )}
        {(stockCode || accountIssuer) && !stock?.summary ? (
          <p role="status" className="text-sm text-muted-foreground">
            The notice and fund registers are temporarily unavailable.
          </p>
        ) : null}
        {!rows.length &&
          !institutions.length &&
          !history.length &&
          !fundFiles.length &&
          !funds.length &&
          !managed.length &&
          !relatedPeople.length &&
          !directorRows.length && (
            <p className="text-sm text-muted-foreground">
              No named ownership connections in the available records.
            </p>
          )}
      </div>
    </DashboardLayout>
  );
}
