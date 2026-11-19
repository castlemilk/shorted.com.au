import { XMLParser, XMLValidator } from "fast-xml-parser";

export interface Filing {
  accession: string;
  form: string;
  period: string;
  filed: string;
}

export interface Position {
  issuer: string;
  securityClass: string;
  cusip: string;
  option: string;
  unit: string;
  quantity: number;
  usd: number;
}

export interface Snapshot {
  filing: Filing;
  manager: string;
  positions: Position[];
  totalUsd: number;
  confidentialOmitted: boolean | null;
}

export function edgarUrl(
  cik: string,
  filing: Filing,
  file: "index.htm" | "txt" = "index.htm",
): string {
  const { accession } = filing;
  const suffix = file === "txt" ? ".txt" : "-index.htm";
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll("-", "")}/${accession}${suffix}`;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Missing SEC record");
  return value as Record<string, unknown>;
}

function field(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("Missing SEC field");
  return value.trim();
}

function integer(value: unknown): number {
  const raw = field(value);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new Error("Invalid 13F amount");
  return Number(raw);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;

// Group by reporting period, not filing date. A later amendment to an old period
// must not displace a newer quarter. Keep every amendment and notice in scope.
export function recentPeriods(submissions: unknown, cik: string): Filing[][] {
  const root = record(submissions);
  if (root.cik !== cik) throw new Error("Different SEC filer");
  const data = record(record(root.filings).recent);
  const { form, reportDate, filingDate, accessionNumber } = data;
  if (
    !Array.isArray(form) ||
    !Array.isArray(reportDate) ||
    !Array.isArray(filingDate) ||
    !Array.isArray(accessionNumber) ||
    [reportDate, filingDate, accessionNumber].some(
      (a) => a.length !== form.length,
    )
  ) {
    throw new Error("Incomplete EDGAR submissions index");
  }
  const groups = new Map<string, Filing[]>();
  for (let i = 0; i < form.length; i++) {
    const type = field(form[i]);
    if (!/^13F-(HR|NT)(\/A)?$/.test(type)) continue;
    const period = field(reportDate[i]);
    const filed = field(filingDate[i]);
    const accession = field(accessionNumber[i]);
    if (!DATE.test(period) || !DATE.test(filed) || !ACCESSION.test(accession))
      throw new Error("Invalid filing reference");
    const filings = groups.get(period) ?? [];
    filings.push({ form: type, period, filed, accession });
    groups.set(period, filings);
  }
  return [...groups.keys()]
    .sort()
    .reverse()
    .slice(0, 2)
    .map((period) =>
      groups
        .get(period)!
        .sort(
          (a, b) =>
            b.filed.localeCompare(a.filed) ||
            b.accession.localeCompare(a.accession),
        ),
    );
}

const parser = new XMLParser({
  removeNSPrefix: true,
  parseTagValue: false,
  ignoreAttributes: true,
});

function documentXml(raw: string, type: string): Record<string, unknown> {
  const docs = [...raw.matchAll(/<DOCUMENT>([\s\S]*?)<\/DOCUMENT>/gi)]
    .map((match) => match[1]!)
    .filter((doc) => doc.match(/<TYPE>([^\r\n<]+)/i)?.[1]?.trim() === type);
  const xml =
    docs.length === 1 && docs[0]!.match(/<XML>\s*([\s\S]*?)\s*<\/XML>/i)?.[1];
  if (!xml || /<!DOCTYPE/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new Error("Incomplete filing XML");
  return record(parser.parse(xml));
}

export function parse13F(raw: string, cik: string, filing: Filing): Snapshot {
  // The older 13F schema stated values in thousands. This reader handles the dollar-era filings.
  if (
    filing.form !== "13F-HR" ||
    filing.filed < "2023-03-01" ||
    !raw.startsWith(`<SEC-DOCUMENT>${filing.accession}.txt`)
  ) {
    throw new Error("Unsupported 13F filing");
  }
  const cover = record(documentXml(raw, "13F-HR").edgarSubmission);
  const header = record(cover.headerData);
  const filer = record(record(record(header.filerInfo).filer).credentials);
  const data = record(cover.formData);
  const page = record(data.coverPage);
  const [year, month, day] = filing.period.split("-");
  if (
    filer.cik !== cik ||
    header.submissionType !== filing.form ||
    page.reportCalendarOrQuarter !== `${month}-${day}-${year}` ||
    page.reportType !== "13F HOLDINGS REPORT"
  ) {
    throw new Error("Filing identity or report type mismatch");
  }
  const summary = record(data.summaryPage);
  const count = integer(summary.tableEntryTotal);
  const totalUsd = integer(summary.tableValueTotal);
  const table = documentXml(raw, "INFORMATION TABLE").informationTable;
  const entries = table === "" ? undefined : record(table).infoTable;
  const rows: unknown[] =
    entries == null ? [] : Array.isArray(entries) ? entries : [entries];
  const positions = rows.map((entry): Position => {
    const row = record(entry);
    const amount = record(row.shrsOrPrnAmt);
    const unit = field(amount.sshPrnamtType);
    const option = row.putCall == null ? "" : field(row.putCall).toUpperCase();
    if (!["SH", "PRN"].includes(unit) || !["", "CALL", "PUT"].includes(option))
      throw new Error("Unsupported security unit");
    return {
      issuer: field(row.nameOfIssuer),
      securityClass: field(row.titleOfClass),
      cusip: field(row.cusip),
      option,
      unit,
      quantity: integer(amount.sshPrnamt),
      usd: integer(row.value),
    };
  });
  if (count !== positions.length)
    throw new Error("Missing entries from the 13F information table");
  // The cover and rows can disagree in a real filing. Preserve both for display.
  return {
    filing,
    manager: field(record(page.filingManager).name),
    positions,
    totalUsd,
    confidentialOmitted:
      summary.isConfidentialOmitted == null
        ? null
        : ["true", "1", "Y"].includes(String(summary.isConfidentialOmitted)),
  };
}
