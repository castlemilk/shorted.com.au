import Link from "next/link";
import css from "./paths.module.css";
import { MoveRight } from "lucide-react";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { GRAPH_PATH, graphHref } from "~/@/lib/ownership/graph-links";
import { pageTitle, sectionTitle } from "~/@/lib/typography";
import {
  graphRecords,
  graphSearchItems,
  localGraphNode,
} from "~/server/traders/ownership-graph";
import { listInstitutions } from "~/app/actions/getOwnership";
import { InvestorThumbnail } from "../traders/investor-thumbnail";
import { GraphSearch } from "./graph-search";
import { NodeLink } from "./ownership-paths";

const startingPoints = [
  ["KGN", "david-shafer", "shafer-corporation"],
  ["WCN", "gina-rinehart", "hancock-prospecting"],
  ["FMG", "andrew-and-nicola-forrest", "tattarang"],
] as const;

export async function GraphIndex() {
  const directory = await listInstitutions("", "", 200, 0);
  const search = new Map(graphSearchItems.map((i) => [i.href, i]));
  for (const institution of directory?.institutions ?? []) {
    const href = graphHref("institution", institution.slug);
    search.set(href, { name: institution.name, detail: "Institution", href });
  }
  const issuers = [...new Set(graphRecords.map((r) => r.company.id))].sort();
  const people = new Set(graphRecords.map((r) => r.person.id));
  const nodeLink =
    css.previewStep +
    " inline-flex min-h-10 min-w-0 items-center gap-2 font-medium text-primary underline decoration-primary/35 underline-offset-4 hover:decoration-primary";
  return (
    <DashboardLayout>
      <div className="mx-auto min-w-0 max-w-6xl space-y-6 sm:space-y-8">
        <Link
          prefetch={false}
          href="/ownership/connections"
          className="inline-flex min-h-8 items-center text-sm text-muted-foreground sm:hidden"
        >
          ← Ownership connections
        </Link>
        <Breadcrumbs
          className="max-sm:hidden"
          prefetch={false}
          items={[
            { label: "Ownership", href: "/ownership" },
            { label: "Connections", href: "/ownership/connections" },
            { label: "Ownership graph", href: GRAPH_PATH },
          ]}
        />
        <header className="grid items-end gap-4 border-b pb-4 sm:grid-cols-[minmax(0,1fr)_minmax(15rem,23rem)]">
          <div>
            <h1 className={pageTitle}>Ownership graph</h1>
            <p className="mt-2 max-w-prose text-sm text-muted-foreground">
              {people.size} named investor profiles across {issuers.length} ASX
              issuers. Follow a holding to its account and the filing that names
              it.
            </p>
          </div>
          <GraphSearch items={[...search.values()]} />
        </header>
        <section aria-label="Company ownership paths">
          <h2 className={sectionTitle}>Company ownership paths</h2>
          <ul className="mt-3 divide-y border-y">
            {startingPoints.map(([code, slug, organisation]) => {
              const person = localGraphNode("person", slug)!,
                company = localGraphNode("company", code)!,
                vehicle = localGraphNode("organisation", organisation)!;
              return (
                <li
                  key={code}
                  className={
                    css.previewPath +
                    " grid min-w-0 items-center gap-x-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.15fr)_auto_minmax(0,1.15fr)]"
                  }
                >
                  <NodeLink node={company} className={nodeLink}>
                    <span className="text-xs text-muted-foreground">
                      {code}
                    </span>
                    {company.name}
                  </NodeLink>
                  <MoveRight
                    aria-hidden="true"
                    className="hidden size-4 text-muted-foreground sm:block"
                  />
                  <NodeLink node={person} className={nodeLink}>
                    <InvestorThumbnail slug={slug} size="graph" />
                    <span>{person.name}</span>
                  </NodeLink>
                  <MoveRight
                    aria-hidden="true"
                    className="hidden size-4 text-muted-foreground sm:block"
                  />
                  <NodeLink node={vehicle} className={nodeLink} />
                </li>
              );
            })}
          </ul>
        </section>
        <section aria-label="Browse companies">
          <h2 className={sectionTitle}>Browse companies</h2>
          <ul className="mt-3 grid gap-x-6 border-t sm:grid-cols-2 lg:grid-cols-3">
            {issuers.map((code) => {
              const company = localGraphNode("company", code)!;
              return (
                <li key={code} className="border-b">
                  <Link
                    prefetch={false}
                    href={graphHref("company", code)}
                    className="flex min-h-11 items-baseline gap-3 py-2 text-sm hover:text-primary hover:underline"
                  >
                    <strong className="w-9 shrink-0">{code}</strong>
                    <span>{company.name}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </DashboardLayout>
  );
}
