import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { StocksSearchClient } from "./components/stocks-search-client";

// Popular ASX stocks for quick access (pre-rendered on server)
const POPULAR_STOCKS = [
  { code: "CBA", name: "Commonwealth Bank" },
  { code: "BHP", name: "BHP Group" },
  { code: "CSL", name: "CSL Limited" },
  { code: "WBC", name: "Westpac" },
  { code: "ANZ", name: "ANZ Bank" },
  { code: "NAB", name: "National Australia Bank" },
  { code: "WOW", name: "Woolworths" },
  { code: "WES", name: "Wesfarmers" },
  { code: "RIO", name: "Rio Tinto" },
  { code: "TLS", name: "Telstra" },
  { code: "XRO", name: "Xero" },
  { code: "MQG", name: "Macquarie Group" },
];

export default function StocksPage() {
  return (
    <DashboardLayout>
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Stock Search & Analysis</h1>
        <p className="text-muted-foreground">
          Search ASX stocks by code, company name, or industry
        </p>
      </div>

      {/* Search Client Component (handles all interactive search functionality) */}
      <StocksSearchClient popularStocks={POPULAR_STOCKS} />
    </DashboardLayout>
  );
}
