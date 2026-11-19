"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/@/components/ui/table";
import { directorHref, directorKey } from "~/@/lib/ownership/traders";

export interface DirectorRecord {
  id: string;
  director: string;
  date: string;
  type: string;
  units: string;
  value: string;
  price: string;
  source?: string;
}

type RecordsProps = { code: string; rows: DirectorRecord[] };

function RecordTable({
  rows,
  code,
  selected,
}: RecordsProps & { selected: string }) {
  const names = new Map<string, string>();
  for (const row of rows) {
    const key = directorKey(row.director);
    if (!names.has(key)) names.set(key, row.director);
  }
  const visible = selected
    ? rows.filter((row) => directorKey(row.director) === selected)
    : rows;
  const director = names.get(selected);
  const counts = new Map<string, number>();
  if (director) {
    for (const row of visible)
      counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
  }
  return (
    <div className="space-y-4">
      <label className="flex flex-wrap items-center gap-3 text-sm font-medium">
        Director
        <select
          value={selected}
          className="max-w-full rounded-md border bg-background px-3 py-2"
          onChange={(event) =>
            window.history.pushState(
              null,
              "",
              directorHref(code, event.target.value),
            )
          }
        >
          <option value="">All named directors</option>
          {selected && !names.has(selected) && (
            <option value={selected}>{selected}</option>
          )}
          {[...names]
            .sort((a, b) => a[1].localeCompare(b[1], "en-AU"))
            .map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
        </select>
      </label>
      {director && (
        <section
          aria-label="Director activity"
          className="space-y-3 rounded-md border bg-card p-4"
        >
          <h2 className="font-serif text-2xl font-semibold">{director}</h2>
          <dl className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">
                Latest disclosed change
              </dt>
              <dd className="mt-1 tabular-nums">{visible[0]?.date}</dd>
            </div>
            {Array.from(counts, ([type, count]) => (
              <div key={type}>
                <dt className="text-xs text-muted-foreground">{type}</dt>
                <dd className="mt-1 tabular-nums">{count}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <div aria-live="polite" className="text-sm text-muted-foreground">
        {visible.length
          ? `${visible.length} disclosed change${visible.length === 1 ? "" : "s"}${selected ? ` for ${names.get(selected)}` : ""}`
          : `No named, quantified changes${selected ? " for this director" : ""} in the records reviewed for ${code}.`}
      </div>
      {visible.length > 0 && (
        <Table>
          <caption className="sr-only">
            Director interest changes disclosed for {code}
          </caption>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Director</TableHead>
              <TableHead>Change</TableHead>
              <TableHead className="text-right">Units</TableHead>
              <TableHead className="text-right">Price (A$)</TableHead>
              <TableHead className="text-right">Value (A$)</TableHead>
              <TableHead>Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="whitespace-nowrap">{row.date}</TableCell>
                <TableCell>{row.director}</TableCell>
                <TableCell>{row.type}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.units}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.price}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.value}
                </TableCell>
                <TableCell>
                  {row.source ? (
                    <a
                      href={row.source}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline-offset-4 hover:underline"
                      aria-label={`Source filing for ${row.director} on ${row.date}`}
                    >
                      Filing ↗
                    </a>
                  ) : (
                    "n/a"
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function LinkedRecords(props: RecordsProps) {
  const params = useSearchParams();
  return (
    <RecordTable
      {...props}
      selected={directorKey(params?.get("director") ?? "").slice(0, 200)}
    />
  );
}

export function DirectorRecords(props: RecordsProps) {
  return (
    <Suspense fallback={<RecordTable {...props} selected="" />}>
      <LinkedRecords {...props} />
    </Suspense>
  );
}
