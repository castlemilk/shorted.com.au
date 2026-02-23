/**
 * Converts an array of objects to CSV format and triggers a browser download.
 *
 * @param data - Array of row objects to export
 * @param filename - Name of the downloaded file (should include .csv extension)
 * @param headers - Optional mapping from data keys to display header names.
 *                  When provided, only these keys are included in the output
 *                  and the order follows Object.keys(headers).
 */
export function downloadCSV(
  data: Record<string, unknown>[],
  filename: string,
  headers?: Record<string, string>,
): void {
  if (data.length === 0) return;

  const keys = Object.keys(headers ?? data[0]!);
  const headerRow = keys.map((k) => headers?.[k] ?? k);

  const rows = data.map((row) =>
    keys
      .map((key) => {
        const val = row[key];
        const str = val == null ? "" : String(val);
        // Escape quotes and wrap in quotes if the value contains a comma,
        // double-quote, or newline character.
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      })
      .join(","),
  );

  const csv = [headerRow.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
