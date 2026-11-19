import Link from "next/link";
import { ArrowUpRight, Building2, GitBranch, UsersRound } from "lucide-react";
import { graphHref } from "~/@/lib/ownership/graph-links";
import { formatIsoDate } from "~/@/lib/strategies/format";
import {
  graphRole,
  type GraphNode,
  type GraphRecord,
} from "~/server/traders/ownership-graph";
import { InvestorThumbnail } from "../traders/investor-thumbnail";
import css from "./paths.module.css";

const link =
  "text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary";
export function NodeLink({
  node,
  children,
  className = "",
}: {
  node: GraphNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      prefetch={false}
      href={graphHref(node.kind, node.id)}
      className={className}
    >
      {children ?? node.name}
    </Link>
  );
}
function Evidence({ row }: { row: GraphRecord }) {
  return (
    <div className={css.evidence}>
      {row.value ? (
        <>
          <strong className="text-lg font-semibold tabular-nums">
            {row.value}
          </strong>
          <span className="text-xs text-muted-foreground">{row.unit}</span>
        </>
      ) : typeof row.shares === "number" ? (
        <strong className="text-sm tabular-nums">
          {row.shares.toLocaleString("en-AU")} shares
        </strong>
      ) : (
        <strong className="text-sm">{row.unit}</strong>
      )}
      {row.shares !== undefined && row.value && (
        <span className="text-xs tabular-nums">
          {row.shares.toLocaleString("en-AU")} shares
        </span>
      )}
      <a href={row.source} className={link + " text-xs"}>
        {row.document}
      </a>
      {row.date && (
        <span className="text-xs text-muted-foreground">
          {row.yearEnd ? "Year ended " : ""}
          <time dateTime={row.date}>{formatIsoDate(row.date)}</time>
        </span>
      )}
    </div>
  );
}

function LinkedRecords({
  focus,
  records,
}: {
  focus: GraphNode;
  records: GraphRecord[];
}) {
  const paths = new Map<
    string,
    { vehicles: GraphNode[]; rows: GraphRecord[] }
  >();
  for (const row of records) {
    const vehicles = row.vehicles.filter((v) => v.id !== focus.id);
    // Different filing sources can establish different relationships.
    const key = vehicles.map((v) => v.id).join("/") + ":" + row.identitySource;
    const group = paths.get(key) ?? { vehicles, rows: [] };
    group.rows.push(row);
    paths.set(key, group);
  }
  return (
    <ul className={css.connections}>
      {[...paths].map(([key, { vehicles, rows }]) => {
        const first = rows[0]!;
        return (
          <li key={key} className={css.route} data-via={vehicles.length > 0}>
            {vehicles.length > 0 && (
              <div className={css.vehicle}>
                <span className="text-xs text-muted-foreground">
                  Named in holding
                </span>
                {vehicles.map((v) => (
                  <NodeLink key={v.id} node={v} className={css.vehicleLink}>
                    <GitBranch aria-hidden="true" className="size-4 shrink-0" />
                    {v.name}
                  </NodeLink>
                ))}
                {first.identitySource !== first.source && (
                  <a className={link + " text-xs"} href={first.identitySource}>
                    Identity disclosure{" "}
                    <ArrowUpRight
                      className="inline size-3"
                      aria-hidden="true"
                    />
                  </a>
                )}
              </div>
            )}
            <ul className={css.holdings}>
              {rows.map((r) => (
                <li
                  key={[r.account.id, r.source, r.rank].join("/")}
                  className={css.record}
                >
                  <div className={css.account}>
                    {r.rank && (
                      <span className="mb-1 text-xs text-muted-foreground">
                        Register position{" "}
                        <span className="tabular-nums">#{r.rank}</span>
                      </span>
                    )}
                    {focus.kind === "account" ? (
                      <NodeLink node={r.company} className={css.accountLink}>
                        {r.company.name} · {r.company.id}
                      </NodeLink>
                    ) : (
                      <NodeLink node={r.account} className={css.accountLink} />
                    )}
                    {focus.kind === "organisation" && (
                      <NodeLink
                        node={r.company}
                        className={link + " mt-1 text-xs"}
                      >
                        {r.company.name} · {r.company.id}
                      </NodeLink>
                    )}
                    {!vehicles.length && r.identitySource !== r.source && (
                      <a
                        className={link + " mt-1 text-xs"}
                        href={r.identitySource}
                      >
                        Identity disclosure ↗
                      </a>
                    )}
                  </div>
                  <Evidence row={r} />
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

export function OwnershipPaths({
  focus,
  rows,
}: {
  focus: GraphNode;
  rows: GraphRecord[];
}) {
  const groups = new Map<string, { node: GraphNode; rows: GraphRecord[] }>();
  for (const row of rows) {
    const node = focus.kind === "person" ? row.company : row.person;
    const group = groups.get(node.id) ?? { node, rows: [] };
    group.rows.push(row);
    groups.set(node.id, group);
  }
  const branches = [...groups.values()];
  if (!branches.length) return null;
  function branch({ node, rows: records }: (typeof branches)[number]) {
    const role =
      node.kind === "person"
        ? graphRole(node, records[0]!.company.id)
        : undefined;
    return (
      <li className={css.branch} key={node.id}>
        <div className={css.person}>
          <NodeLink
            node={node}
            className="group flex min-w-0 items-center gap-3"
          >
            {node.kind === "person" ? (
              <InvestorThumbnail slug={node.id} size="graph" />
            ) : (
              <Building2
                className="size-5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            )}
            <span className="min-w-0">
              <span className="block text-base font-semibold leading-tight underline-offset-4 group-hover:text-primary group-hover:underline">
                {node.name}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {node.kind === "company"
                  ? "ASX · " + node.id
                  : (role?.role ?? "Named in filing")}
              </span>
            </span>
          </NodeLink>
          {role && (
            <a
              className={link + " mt-1 inline-block text-xs"}
              href={role.source}
            >
              {role.sourceLabel}
            </a>
          )}
        </div>
        <LinkedRecords focus={focus} records={records} />
      </li>
    );
  }
  const count = new Set(rows.map((r) => r.account.id)).size;
  return (
    <section aria-label="Ownership paths" className="min-w-0">
      <div className={css.columns} aria-hidden="true">
        <span>Selected {focus.kind}</span>
        <span>{focus.kind === "person" ? "Company" : "People"}</span>
        <span>Holding entity</span>
        <span>
          {focus.kind === "account" ? "Issuer" : "Filed account or interest"}
        </span>
        <span>Disclosure</span>
      </div>
      <div className={css.map}>
        <div className={css.root}>
          <span className={css.rootIcon}>
            {focus.kind === "company" ? (
              <Building2 aria-hidden="true" />
            ) : focus.kind === "person" ? (
              <UsersRound aria-hidden="true" />
            ) : (
              <GitBranch aria-hidden="true" />
            )}
          </span>
          <span className="min-w-0">
            <strong className="block break-words text-base font-semibold">
              {focus.kind === "company" ? "ASX · " + focus.id : focus.name}
            </strong>
            <span className={css.summary}>
              {focus.kind === "company" && (
                <span>
                  {branches.length}{" "}
                  {branches.length === 1 ? "person" : "people"}
                </span>
              )}
              <span>
                {count} filed {count === 1 ? "name" : "names"}
              </span>
            </span>
          </span>
        </div>
        <div className={css.tree}>
          <ul
            aria-label="Connected people and holdings"
            className={css.branches}
          >
            {branches.slice(0, 6).map(branch)}
          </ul>
          {branches.length > 6 && (
            <details className="ml-5 border-t py-2">
              <summary className="cursor-pointer py-2 text-sm text-primary">
                Show {branches.length - 6} more connections
              </summary>
              <ul className={css.branches}>{branches.slice(6).map(branch)}</ul>
            </details>
          )}
        </div>
      </div>
    </section>
  );
}
