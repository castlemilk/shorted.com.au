import type { Metadata } from "next";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { NoticeFeedExplorer } from "~/@/components/ownership/notice-feed-explorer";
import { ChangesInspector } from "~/@/components/ownership/funds/changes-inspector";
import { FundChangesTable } from "~/@/components/ownership/funds/fund-changes-table";
import { UrlTabs } from "~/@/components/ownership/funds/url-tabs";
import {
  CHANGES_TAB_LABELS,
  defaultCompareFund,
  defaultPair,
  orderFundsForCompare,
} from "~/@/components/ownership/funds/fund-model";
import { WorkspacePage } from "~/@/components/workspace/workspace-page";
import { MethodDisclosure } from "~/@/components/ownership/workspace/method-disclosure";
import { lede, pageTitle } from "@/lib/typography";
import { bailOnEmptyRender } from "~/app/actions/config";
import { listInstitutions } from "~/app/actions/getOwnership";
import { loadNoticeFeed } from "~/app/actions/ownershipExplorer";
import {
  compareFundSnapshots,
  loadFundPortfolio,
  loadFunds,
  resolveChangeSelection,
} from "~/app/actions/ownershipFunds";
import type { FundComparison } from "~/@/components/ownership/funds/fund-model";

// Static ISR: the Changes page reads no search parameter. Its tab, its fund and its
// two dates are read by the islands from the URL in the browser (spec 14.3).
export const revalidate = 3600;

const URL = "https://shorted.com.au/ownership/changes";
const TITLE = "What changed in ASX ownership";
const DESCRIPTION =
  "Compare two reported snapshots of an index fund's ASX holdings, and read the substantial holding notices released as they change.";
const BASE_PATH = "/ownership/changes";
/**
 * The notice feed's own parameters. Its filter chips rebuild the query from these alone,
 * so a chip's link names no tab; a URL that names one of them opens the notices tab.
 */
const NOTICE_FEED_PARAMS = ["window", "since", "until", "event", "kind", "stock", "industry", "holder", "cursor"];

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: URL },
  openGraph: { type: "website", url: URL, title: TITLE, description: DESCRIPTION, siteName: "Shorted", locale: "en_AU" },
  twitter: { card: "summary_large_image", site: "@shorted___", creator: "@shorted___" },
};

const CRUMBS = [
  { label: "Ownership", href: "/ownership" },
  { label: "Changes", href: BASE_PATH },
];

const EMPTY_COMPARISON: FundComparison = { ok: false, from: "", to: "", sourceFrom: "", sourceTo: "", rows: [] };

export default async function ChangesPage() {
  const [funds, feed, directory] = await Promise.all([
    loadFunds(),
    loadNoticeFeed({}),
    listInstitutions("", "", 200, 0),
  ]);

  // The Fund select lists the funds with two file dates first (a fund with one is still listed,
  // after them). The default is the first index fund with two files, read with its two newest
  // file dates; an empty registry leaves the table with no fund.
  const options = orderFundsForCompare(funds.funds).map((fund) => ({
    key: fund.key,
    ticker: fund.ticker,
    name: fund.name,
    snapshotCount: fund.snapshotCount ?? 0,
  }));
  const defaultFund = defaultCompareFund(funds.funds);
  let defaultDates: string[] = [];
  let comparison: FundComparison = EMPTY_COMPARISON;
  let datesFailed = false;
  if (defaultFund) {
    const portfolio = await loadFundPortfolio({ fundKey: defaultFund.key });
    defaultDates = portfolio.fund?.snapshotDates ?? [];
    datesFailed = !portfolio.ok;
  }
  const pair = defaultPair(defaultDates);
  if (defaultFund && pair.from !== "" && pair.to !== "") {
    comparison = await compareFundSnapshots({ fundKey: defaultFund.key, from: pair.from, to: pair.to });
  }
  const defaults = { fund: defaultFund?.key ?? "", from: pair.from, to: pair.to };

  // A read that did not answer is a shell: the page bails so the cache is shortened. The
  // default comparison is part of that: its error copy must not be baked in for an hour.
  const comparisonFailed = defaultFund !== undefined && pair.from !== "" && pair.to !== "" && !comparison.ok;
  const failed = !funds.ok || !feed.ok || !feed.activityOk || directory === undefined || datesFailed || comparisonFailed;
  // An honest empty feed is the page's content (spec 14.8): only a read that failed is a shell.
  if (failed) await bailOnEmptyRender();

  // The registry the notice feed's holder select reads: the whole directory only (see notices/page.tsx).
  const holders =
    directory !== undefined && directory.total <= directory.institutions.length
      ? directory.institutions.map((inst) => ({ slug: inst.slug, name: inst.name }))
      : [];

  return (
    <DashboardLayout fullWidth>
      <WorkspacePage inspector={<ChangesInspector resolve={resolveChangeSelection} defaults={defaults} />}>
        <div className="space-y-6">
          <Breadcrumbs items={CRUMBS} />
          <header>
            <h1 className={pageTitle}>What changed?</h1>
            <p className={lede}>Compare reported snapshots or inspect new disclosures.</p>
          </header>
          {failed ? <span hidden data-isr-shell="empty" /> : null}
          <UrlTabs
            label="Changes"
            defaultTab="funds"
            inferFrom={{ tab: "notices", when: NOTICE_FEED_PARAMS }}
            tabs={[
              {
                id: "funds",
                label: CHANGES_TAB_LABELS.funds,
                panel: (
                  <FundChangesTable
                    funds={options}
                    defaults={defaults}
                    defaultDates={defaultDates}
                    initial={comparison}
                    loadPortfolio={loadFundPortfolio}
                    compare={compareFundSnapshots}
                  />
                ),
              },
              {
                id: "notices",
                label: CHANGES_TAB_LABELS.notices,
                panel: <NoticeFeedExplorer initial={feed} loadPage={loadNoticeFeed} holders={holders} basePath={BASE_PATH} />,
              },
            ]}
          />
          <MethodDisclosure />
        </div>
      </WorkspacePage>
    </DashboardLayout>
  );
}
