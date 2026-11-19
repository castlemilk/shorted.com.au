import { cache } from "react";
import {
  edgarUrl,
  parse13F,
  recentPeriods,
  type Filing,
  type Snapshot,
} from "./sec-filings";
import saved from "./verified-filings.json";

export interface FilingPeriod {
  filings: Filing[];
  snapshot?: Snapshot;
  note?: string;
}

export interface SecHoldings {
  archived: boolean;
  periods: FilingPeriod[];
}

const verified: Readonly<Record<string, Snapshot[]>> = saved;
const DAY = 86_400;

async function secFetch(url: string, ttl: number): Promise<Response> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Shorted ownership research (support@shorted.com.au)",
    },
    next: { revalidate: ttl },
    signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) throw new Error(`SEC returned ${res.status}`);
  return res;
}

async function readPeriod(
  cik: string,
  filings: Filing[],
  savedReports: Snapshot[],
): Promise<FilingPeriod> {
  const filing = filings[0]!;
  if (filings.length > 1 || filing.form !== "13F-HR") {
    return {
      filings,
      note: "Use the linked filings for this period. Amendments and notice-only reports require reading the manager’s filing history together.",
    };
  }
  // An accession identifies an immutable filing. An amendment has its own accession.
  const known = savedReports.find(
    (snapshot) => snapshot.filing.accession === filing.accession,
  );
  if (known) return { filings, snapshot: known };

  try {
    const response = await secFetch(edgarUrl(cik, filing, "txt"), 30 * DAY);
    const snapshot = parse13F(await response.text(), cik, filing);
    return { filings, snapshot };
  } catch {
    return {
      filings,
      note: "The position table is unavailable. The SEC filing is linked below.",
    };
  }
}

export const getSecHoldings = cache(
  async (cik: string): Promise<SecHoldings> => {
    const savedReports = verified[cik] ?? [];
    let groups: Filing[][];
    try {
      const response = await secFetch(
        `https://data.sec.gov/submissions/CIK${cik}.json`,
        DAY,
      );
      groups = recentPeriods(await response.json(), cik);
      if (!groups.length && savedReports.length)
        throw new Error("No recent filings in the SEC index");
    } catch {
      return {
        archived: true,
        periods: savedReports.map((snapshot) => ({
          filings: [snapshot.filing],
          snapshot,
        })),
      };
    }
    return {
      archived: false,
      periods: await Promise.all(
        groups.map((group) => readPeriod(cik, group, savedReports)),
      ),
    };
  },
);
