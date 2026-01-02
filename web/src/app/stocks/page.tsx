import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { StocksSearchClient } from "./components/stocks-search-client";
import { TrendingUp, BarChart3, Sparkles } from "lucide-react";

// Popular ASX stocks for quick access (pre-rendered on server)
const POPULAR_STOCKS = [
  { code: "CBA", name: "Commonwealth Bank", sector: "Banking" },
  { code: "BHP", name: "BHP Group", sector: "Mining" },
  { code: "CSL", name: "CSL Limited", sector: "Healthcare" },
  { code: "WBC", name: "Westpac", sector: "Banking" },
  { code: "ANZ", name: "ANZ Bank", sector: "Banking" },
  { code: "NAB", name: "National Australia Bank", sector: "Banking" },
  { code: "WOW", name: "Woolworths", sector: "Retail" },
  { code: "WES", name: "Wesfarmers", sector: "Conglomerate" },
  { code: "RIO", name: "Rio Tinto", sector: "Mining" },
  { code: "TLS", name: "Telstra", sector: "Telecom" },
  { code: "XRO", name: "Xero", sector: "Technology" },
  { code: "MQG", name: "Macquarie Group", sector: "Financial" },
];

export default function StocksPage() {
  return (
    <DashboardLayout>
      {/* Hero Section with Animated Background */}
      <div className="relative -mx-4 -mt-4 px-4 pt-8 pb-12 mb-8 overflow-hidden">
        {/* Animated gradient background */}
        <div className="absolute inset-0 bg-gradient-to-br from-blue-600/10 via-indigo-500/5 to-purple-600/10 dark:from-blue-500/20 dark:via-indigo-400/10 dark:to-purple-500/15" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-cyan-400/20 via-transparent to-transparent dark:from-cyan-400/10" />
        
        {/* Grid pattern overlay */}
        <div 
          className="absolute inset-0 opacity-[0.015] dark:opacity-[0.03]"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23000' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
          }}
        />

        {/* Floating decorative elements */}
        <div className="absolute top-8 right-[15%] w-24 h-24 bg-blue-500/10 dark:bg-blue-400/10 rounded-full blur-3xl animate-pulse" />
        <div className="absolute bottom-4 left-[10%] w-32 h-32 bg-purple-500/10 dark:bg-purple-400/10 rounded-full blur-3xl animate-pulse delay-1000" />
        
        <div className="relative z-10 max-w-4xl">
          {/* Pill badge */}
          <div className="inline-flex items-center gap-2 px-3 py-1.5 mb-4 rounded-full bg-blue-500/10 dark:bg-blue-400/15 border border-blue-500/20 dark:border-blue-400/20 text-blue-600 dark:text-blue-400 text-sm font-medium animate-in fade-in slide-in-from-bottom-2 duration-500">
            <Sparkles className="w-3.5 h-3.5" />
            <span>Real-time ASX Data</span>
          </div>
          
          {/* Main heading with gradient text */}
          <h1 className="text-4xl md:text-5xl font-bold mb-4 tracking-tight animate-in fade-in slide-in-from-bottom-3 duration-500 delay-100">
            <span className="bg-gradient-to-r from-foreground via-foreground to-foreground/70 dark:from-white dark:via-white dark:to-white/60 bg-clip-text text-transparent">
              Stock Search
            </span>
            <br />
            <span className="bg-gradient-to-r from-blue-600 to-indigo-600 dark:from-blue-400 dark:to-indigo-400 bg-clip-text text-transparent">
              & Analysis
            </span>
          </h1>
          
          <p className="text-lg text-muted-foreground max-w-2xl animate-in fade-in slide-in-from-bottom-4 duration-500 delay-200">
            Discover short positions, track market movements, and analyze ASX-listed companies with real-time data and insights.
          </p>

          {/* Stats row */}
          <div className="flex flex-wrap gap-6 mt-8 animate-in fade-in slide-in-from-bottom-5 duration-500 delay-300">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <div className="p-1.5 rounded-md bg-green-500/10 dark:bg-green-400/15">
                <TrendingUp className="w-4 h-4 text-green-600 dark:text-green-400" />
              </div>
              <span><strong className="text-foreground">2,200+</strong> ASX Stocks</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <div className="p-1.5 rounded-md bg-purple-500/10 dark:bg-purple-400/15">
                <BarChart3 className="w-4 h-4 text-purple-600 dark:text-purple-400" />
              </div>
              <span><strong className="text-foreground">Daily</strong> Short Updates</span>
            </div>
          </div>
        </div>
      </div>

      {/* Search Client Component (handles all interactive search functionality) */}
      <StocksSearchClient popularStocks={POPULAR_STOCKS} />
    </DashboardLayout>
  );
}
