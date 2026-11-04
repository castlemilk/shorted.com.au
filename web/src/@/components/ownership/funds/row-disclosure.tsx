/** A label and a value, as a figure list inside an in-place expander (spec 14.9). */
export function FigureList({ rows }: { rows: ReadonlyArray<{ label: string; value: string }> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 py-2 font-mono text-xs">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="text-right tabular-nums">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
