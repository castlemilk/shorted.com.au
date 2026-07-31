export interface CompareBarRow {
  label: string;
  countA: number;
  countB: number;
}

export interface CompareBarsProps {
  rows: CompareBarRow[];
  colorA: string;
  colorB: string;
  nameA: string;
  nameB: string;
}

function safeCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

export function CompareBars({
  rows,
  colorA,
  colorB,
  nameA,
  nameB,
}: CompareBarsProps) {
  const values = rows.map((row) => ({
    ...row,
    countA: safeCount(row.countA),
    countB: safeCount(row.countB),
  }));
  const maxCount = values.reduce(
    (max, row) => Math.max(max, row.countA, row.countB),
    0,
  );
  const ariaRows = values.length
    ? values
        .map(
          (row) =>
            `${row.label}: ${nameA} ${row.countA}, ${nameB} ${row.countB}`,
        )
        .join("; ")
    : "no categories";

  return (
    <figure className="space-y-3">
      <div
        role="img"
        aria-label={`Comparison of ${nameA} and ${nameB}: ${ariaRows}.`}
        className="space-y-2"
      >
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(5rem,auto)_minmax(0,1fr)] items-end gap-2 text-[11px] text-muted-foreground">
          <span className="text-right">{nameA}</span>
          <span className="text-center">Category</span>
          <span>{nameB}</span>
        </div>
        {values.map((row, index) => (
          <div
            key={`${row.label}-${index}`}
            className="grid grid-cols-[minmax(0,1fr)_minmax(5rem,auto)_minmax(0,1fr)] items-center gap-2"
          >
            <div className="flex min-w-0 items-center justify-end gap-2">
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {row.countA}
              </span>
              <span className="flex h-2 w-full max-w-40 justify-end rounded-sm bg-muted">
                <span
                  data-compare-bar
                  className="block h-2 rounded-sm"
                  style={{
                    width: `${maxCount > 0 ? (row.countA / maxCount) * 100 : 0}%`,
                    backgroundColor: colorA,
                  }}
                />
              </span>
            </div>
            <span
              className="truncate text-center text-[11px] text-foreground"
              title={row.label}
            >
              {row.label}
            </span>
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex h-2 w-full max-w-40 rounded-sm bg-muted">
                <span
                  data-compare-bar
                  className="block h-2 rounded-sm"
                  style={{
                    width: `${maxCount > 0 ? (row.countB / maxCount) * 100 : 0}%`,
                    backgroundColor: colorB,
                  }}
                />
              </span>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {row.countB}
              </span>
            </div>
          </div>
        ))}
      </div>
      <table
        className="sr-only"
        aria-label={`Comparison table for ${nameA} and ${nameB}`}
      >
        <caption>
          Comparison of {nameA} and {nameB}
        </caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">{nameA}</th>
            <th scope="col">{nameB}</th>
          </tr>
        </thead>
        <tbody>
          {values.map((row, index) => (
            <tr key={`${row.label}-${index}`}>
              <th scope="row">{row.label}</th>
              <td className="tabular-nums">{row.countA}</td>
              <td className="tabular-nums">{row.countB}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
