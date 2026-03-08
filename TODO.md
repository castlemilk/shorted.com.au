# TODO: Shorted.com.au Stability & Reliability Roadmap

**Generated:** 2026-02-01
**Purpose:** Prioritized action items to achieve a highly stable, secure, and maintainable codebase.

---

## Priority Legend

- **P0 (Critical)**: Security vulnerabilities or data integrity issues - Fix immediately
- **P1 (High)**: Significant architectural problems affecting reliability - Fix within 1 week
- **P2 (Medium)**: Code quality issues that should be addressed - Fix within 1 month
- **P3 (Low)**: Nice-to-have improvements - Backlog

---

## P0: Critical Security Issues

### Backend Security

- [x] **Migrate JWT library** - `services/shorts/internal/services/shorts/tokens.go:7`
  - Replace `github.com/dgrijalva/jwt-go` with `github.com/golang-jwt/jwt/v5`
  - The old library has critical vulnerabilities (CVE-2020-26160) and is abandoned

- [x] **Remove hardcoded secrets** - `services/shorts/internal/services/shorts/server.go:42`
  - Remove `tokenSecret := "dev-secret"` hardcoded value
  - Fail fast if `TOKEN_SECRET` env var is not set in production
  - Also fix in `middleware_connect.go:95-97` (dev-internal-secret)

- [ ] **Fix Terraform state storage** - `terraform/environments/dev/backend.tf`
  - Move state from local storage to GCS with encryption
  - Local state contains sensitive data and isn't team-accessible

- [ ] **Remove database credentials from Terraform** - `terraform/environments/dev/variables.tf:46`
  - Postgres username hardcoded in Git
  - Move to Secret Manager or environment variables

### Frontend Security

- [ ] **Audit dangerouslySetInnerHTML usage** - 10 files
  - Review all uses in SEO components for XSS risks
  - Ensure structured data uses safe JSON stringification
  - `web/src/app/layout.tsx`, `web/src/@/components/seo/enhanced-structured-data.tsx`

---

## P1: High Priority Reliability Issues

### Backend Reliability

- [x] **Fix panic() in database initialization** - `services/shorts/internal/store/shorts/postgres.go:70-96`
  - Replace panic() with proper error returns
  - Add retry logic with exponential backoff
  - Allow graceful degradation instead of crashing

- [x] **Replace MD5 with SHA-256 for cache keys** - `services/shorts/internal/services/shorts/cache.go:43-46`
  - MD5 has collision risks
  - Also handle JSON marshaling errors (currently silently ignored)

- [ ] **Add consistent query timeouts** - Throughout `services/shorts/internal/store/shorts/`
  - Many queries use `context.Background()` without timeout
  - Standardize on 10-second default timeout
  - Accept context from callers when available

- [ ] **Validate connection pool limits** - `services/shorts/internal/store/shorts/postgres.go:80-84`
  - Supabase has max 60 connections
  - Multiple services with 25 MaxConns each could exhaust pool
  - Document expected replicas and validate: `maxConns * replicas < 60`

- [ ] **Centralize admin email configuration** - `services/shorts/internal/services/shorts/middleware_connect.go:125-139`
  - Hardcoded admin emails in two places
  - Move to environment variable or database
  - Remove e2e-test account from production code

### Frontend Reliability

- [ ] **Fix infinite re-render in dashboard auto-save** - `web/src/app/dashboards/page.tsx:158-180`
  - `markPending` callback recreated every render
  - Use ref pattern to stabilize callback reference
  - JSON.stringify on every render is expensive

- [ ] **Fix useState misuse in widget loader** - `web/src/@/components/dashboard/dashboard-grid.tsx:492-503`
  - Using useState initializer for side effects (should be useEffect)
  - Causes component to load multiple times
  - Memory leaks from unresolved promises

- [x] **Add cleanup to debounced functions** - `web/src/@/components/dashboard/widget-config-form.tsx:88-94`
  - Debounced search not cleaned up on unmount
  - Can cause state updates on unmounted component

- [x] **Fix Memory leak in MultiSeriesChart** - `web/src/@/components/ui/multi-series-chart.tsx:1238`
  - Tooltip uses `Math.random()` as key
  - Creates new DOM nodes on every render
  - Change to stable key like `"multi-series-tooltip"`

---

## P2: Medium Priority Architecture Issues

### Backend Architecture

- [ ] **Standardize error handling patterns** - Throughout services
  - Mix of raw errors, wrapped errors, and Connect errors
  - Create custom error types for domain-specific errors
  - Always wrap errors with context: `fmt.Errorf("operation failed: %w", err)`

- [ ] **Add request ID tracing** - `services/shorts/internal/services/shorts/`
  - No correlation IDs across request lifecycle
  - Add middleware to inject/propagate X-Request-ID
  - Include in all log statements

- [ ] **Implement graceful shutdown** - `services/market-data/main.go:692`
  - Currently uses `http.ListenAndServe` which blocks indefinitely
  - Add signal handling for SIGTERM/SIGINT
  - Drain in-flight requests before shutdown

- [x] **Add cache cleanup cancellation** - `services/shorts/internal/services/shorts/cache.go:117-130`
  - Cleanup goroutine runs forever with no stop mechanism
  - Add context-based cancellation via Close() method

- [ ] **Migrate to Pub/Sub v2** - `services/enrichment-processor/main.go:19`
  - Currently suppressing linter warnings for deprecated v1
  - Follow Google's migration guide

### Frontend Architecture

- [ ] **Standardize data fetching patterns** - Throughout `web/src/`
  - Mix of: Server Actions, React Query, InstantSearch, direct fetches
  - Standardize: Server Components use Server Actions, Client Components use React Query
  - Remove direct API calls from components

- [x] **Fix stale closure in processOfflineQueue** - `web/src/@/hooks/use-auto-save.ts:83-117`
  - Empty dependency array causes stale closures
  - Add `onSave, onSaveSuccess, onSaveError` to dependencies

- [ ] **Fix race condition in undo/redo** - `web/src/@/hooks/use-undo-redo.ts:111-116`
  - Debounced commit creates race with undo operations
  - Flush pending changes before undo/redo

- [ ] **Use string dates in DashboardConfig** - `web/src/@/types/dashboard.ts:152-160`
  - Date objects can't serialize to localStorage
  - Use ISO 8601 strings, convert on use

### Infrastructure

- [x] **Optimize CI for 3-5 minute runs** - `.github/workflows/ci-fast.yml` (NEW)
  - Split sequential test job into parallel jobs
  - Separate unit tests from integration tests (testcontainers)
  - Add lint + typecheck as fast-fail gates
  - Run integration tests only on main branch merge

- [ ] **Remove continue-on-error from tests** - `.github/workflows/ci.yml:525,536,699`
  - Failing tests don't block merges
  - Fix flaky tests instead of ignoring failures

- [ ] **Migrate to ci-fast.yml** - Deprecate old ci.yml
  - Old workflow has disabled jobs and is slow (~10-15 min)
  - New workflow targets 3-5 min with parallel execution
  - Keep terraform-deploy.yml for preview/production deploys

- [x] **Fix Docker base image versions** - `services/shorts/Dockerfile:2`
  - `golang:1.24-alpine` doesn't exist (latest is 1.23)
  - Pin to specific version like `golang:1.24.3-alpine`

- [x] **Pin Alpine version** - `services/shorts/Dockerfile:23`
  - `FROM alpine:latest` is non-reproducible
  - Use `alpine:3.19` or specific version

### Proto/API

- [ ] **Decide on DashboardService** - `proto/shortedapi/dashboard/v1/dashboard.proto`
  - Fully defined in protobuf but NOT implemented
  - Frontend uses localStorage instead
  - Either implement or remove proto

- [x] **Fix TimeSeriesData field numbering** - `proto/shortedtypes/stocks/v1alpha1/stocks.proto`
  - Field number 2 is missing
  - Add `reserved 2;` if field was deleted

- [ ] **Standardize float vs double** - Throughout proto files
  - `Stock` uses `float`, `StockPrice` uses `double`
  - Financial data should use `double` for precision
  - This is a wire-compatible change

---

## P3: Low Priority Improvements

### Code Cleanup

- [ ] **Remove unused storage backends** - `services/shorts/internal/store/shorts/config.go:6-9`
  - FireStore, MemoryStorage, DynamoDB defined but never used
  - Only PostgresStore is implemented

- [x] **Remove CMS directory** - `/cms/` (completed - PayloadCMS fully decommissioned, data migrated to main DB)

- [ ] **Clean up orphaned user.pb.go** - `services/gen/proto/go/user/v1/user.pb.go`
  - Generated code exists without corresponding proto
  - Either remove or restore the proto

- [ ] **Remove empty.proto** - `proto/empty/empty.proto`
  - Serves no purpose beyond satisfying buf
  - Verify build works without it, then remove

- [ ] **Convert TODOs to issues** - Throughout codebase
  - `server.go:42`: "TODO: get from config"
  - `main.go:62`: "TODO: do some work normally"
  - Create GitHub issues and link them

### Documentation

- [ ] **Complete .env.example files** - `web/.env.example`, `services/.env.example`
  - Only 3 variables documented, app uses 20+
  - Document ALL environment variables

- [ ] **Add inline comments for financial terms** - Proto files
  - EPS, P/E ratio, etc. unclear for non-finance developers
  - Add explanatory comments

### Testing

- [ ] **Add error path tests** - Throughout test files
  - Many tests focus on happy paths
  - Add tests for: database failures, timeouts, invalid JWT, malformed input

- [ ] **Increase unit test coverage** - Target 70%+
  - Currently at ~40% threshold
  - Focus on complex business logic

### Performance

- [ ] **Consider code-splitting widget definitions** - `web/src/@/lib/widget-registry.ts:22-59`
  - All widget metadata loaded upfront
  - Could lazy-load definitions on demand

---

## Observability (Missing - High Priority Backlog)

- [ ] **Add structured logging** - Replace `log.Printf` with zerolog/zap
- [ ] **Add distributed tracing** - OpenTelemetry + Cloud Trace
- [ ] **Add error tracking** - Sentry for frontend and backend
- [ ] **Add performance monitoring** - APM solution
- [ ] **Add uptime monitoring** - External health checks (Pingdom/UptimeRobot)
- [ ] **Create runbooks** - Incident response procedures
- [ ] **Add alerting** - PagerDuty/Opsgenie integration

---

## Simplification Opportunities

### High Impact

1. **Consolidate auth stack**: Firebase Auth → NextAuth.js → Custom JWT → PostgreSQL sessions only
2. **Merge sync services**: daily-sync (Python) + market-data-sync (Go) → single Go service
3. **Remove unused proto**: DashboardService proto exists but isn't implemented
4. **Flatten proto structure**: 5 modules → single shorted.proto

### Medium Impact

5. **Consolidate to PostgreSQL**: Remove Firestore dependency for user data
6. **Remove enrichment review workflow**: Direct apply with audit log instead
7. **Standardize service-to-service auth**: Single internal JWT approach

---

## Quick Wins (< 1 day each)

1. ~~Replace `Math.random()` tooltip key with stable string~~ ✅
2. ~~Add `reserved 2;` to TimeSeriesData proto~~ ✅
3. ~~Pin Docker base image versions~~ ✅
4. ~~Add debounce cleanup in widget-config-form~~ ✅
5. Remove disabled jobs from ci.yml
6. Fix typos in IndustryTreeMap proto comments

---

## Metrics for Success

- [ ] Zero P0 issues
- [ ] Zero P1 issues
- [ ] 70%+ test coverage
- [ ] < 5 second cold start for all services
- [ ] < 100ms p95 latency for common queries
- [ ] Zero security vulnerabilities in dependency scan
- [ ] All secrets in Secret Manager (not hardcoded)
- [ ] Observability stack operational (logs, traces, metrics)

---

## V2: Vision Roadmap — "The Bloomberg Terminal for Retail Investors"

**Goal:** Transform Shorted from a data tool into the definitive community-driven, AI-powered Australian market intelligence platform.

**Context:** Shorted.com.au currently operates with 2.1M rows of ASIC data (since 2010), 3.7M stock price records, 4,500 enriched company profiles, AI-generated weekly reports, and a customizable dashboard with 9 widget types. The platform has a working Stripe billing system (free/pro/enterprise tiers), Firebase auth, API token management, and solid GCP infrastructure (Cloud Run, Pub/Sub, Cloud Scheduler, Terraform IaC).

---

### Phase 1: Foundation (Q1–Q2 2026) — News, Data Depth, AI Chat

#### 1.1 News Aggregation Engine

**Vision:** Every stock page becomes a living news hub. Short position spikes are explained by the news alongside them.

**Features:**
- [ ] Multi-source news feed per stock (ASX announcements, AFR, Stockhead, Livewire, Reuters AU)
- [ ] LLM-classified sentiment tags (bullish/bearish/neutral) and relevance scoring via Gemini Flash
- [ ] News markers overlaid on short position time series charts (click to reveal headline)
- [ ] "Breaking news" banner on dashboard — top 3 price-sensitive announcements in last 24h
- [ ] News digest woven into weekly report narrative (extend `weekly-report-generator/llm_generator.go`)
- [ ] "News heat" toggle on industry treemap widget — news volume by sector instead of short % change
- [ ] New dashboard widget: `NEWS_FEED`

**Data sources:**
- ASX announcements — already crawled via `asx-announcement-crawler`, expand to all types
- RSS feeds: AFR Markets, Stockhead (`stockhead.com.au/feed/`), Livewire Markets
- Substantial holder notices — classify from existing announcement stream

**Architecture:**
- New service: `services/news-aggregator/` (Go, Cloud Run Job, runs every 15 min)
- New table: `news_articles` (stock_code, source, headline, url, published_at, sentiment, relevance_score, is_price_sensitive, summary, tags JSONB)
- New Pub/Sub topic: `news-ingested` (feeds alerts, weekly reports, Pulse in later phases)
- New RPCs: `GetStockNews(stock_code, limit, before)`, `GetMarketNews(limit, before)`

**Monetization:** Free = last 7 days, 3 articles/view. Pro = full history, sentiment overlay, alerts.

---

#### 1.2 Expanded Market Data & Company Data

**Vision:** Every stock page becomes a one-stop research hub — financials, insider trading, dividends, peer comparisons.

**Features:**
- [ ] **Director trading / insider transactions** — parse Appendix 3Y from ASX announcements, display "Who's buying/selling?" on stock pages. Director buying a heavily shorted stock = classic contrarian signal.
- [ ] **Dividend history & calendar** — parse Appendix 3A.1, show yield, payout ratio, ex-dates. New widget: "Upcoming dividends for your watchlist"
- [ ] **Corporate actions timeline** — capital raises, buybacks, mergers from ASX announcements
- [ ] **RBA interest rate overlay** — track cash rate decisions, overlay on sector performance charts
- [ ] **Enhanced financial statements** — extend `report-extractor` to extract full P&L, balance sheet, cash flow (already partially in `FinancialStatementSet` proto)
- [ ] **Peer comparison tables** — auto-generate top 5 industry peers comparing short %, market cap, P/E, dividend yield, revenue growth
- [ ] **Daily key metrics auto-refresh** — schedule existing `SyncKeyMetrics` RPC daily via Cloud Scheduler (currently admin-only)

**Data sources:**
- ASX announcements (already ingested — need classification for Appendix 3Y, 3A.1, 3B, 4C, 4D, 4E)
- RBA statistics tables (`rba.gov.au/statistics/tables/`) — CSV Table A2 (Target Cash Rate)
- Yahoo Finance fundamentals (already integrated, extend to more fields)

**Architecture:**
- Extend `asx-announcement-crawler` with announcement type classifiers
- New tables: `director_trades`, `dividend_history`
- New RPCs: `GetDirectorTrades`, `GetDividendHistory`, `GetPeerComparison`
- New service: `services/rba-sync/` (Go, Cloud Run Job, monthly)
- Frontend: Tabbed stock detail page (Overview | Financials | Directors | Dividends | News)

**Monetization:** Free = basic data, 2 reports. Pro = full history, peer comparisons, dividend alerts.

---

#### 1.3 AI Chat MVP — "Ask Shorted"

**Vision:** Conversational interface over Shorted's proprietary 15-year dataset. "Which mining stocks had the biggest short interest increase this month?" — answered with real data, inline citations, and embedded charts.

**Features:**
- [ ] Contextual chat sidebar (sliding panel, pre-loaded with current page context)
- [ ] Data-grounded responses with inline citations to ASIC data, reports, announcements
- [ ] Inline chart generation — AI responds with embedded Visx charts for comparison queries
- [ ] Pre-built question templates as quick-action buttons
- [ ] Conversation history per user (PostgreSQL)
- [ ] RAG pipeline with function-calling over: shorts time series, company metadata, weekly reports, announcements, financials, prices

**Architecture:**
- New service: `services/chat-service/` (Go, Cloud Run, stateless)
- New proto: `ChatService` in `proto/shortedapi/chat/v1/chat.proto` — `SendMessage(stream)`, `GetConversationHistory`, `DeleteConversation`
- **Function calling tools** the LLM can invoke: `query_short_positions(stock_code, period)`, `get_top_shorts(limit, period)`, `get_stock_details(stock_code)`, `search_stocks(query)`, `get_news(stock_code, days)`, `get_financial_highlights(stock_code)` — mapped to existing store methods
- Streaming via Connect-RPC server streaming + `ReadableStream` on frontend
- Context: system prompt + function call results + last 10 turns, kept under 30K tokens
- Frontend: `<ChatSidebar>` (shadcn Sheet), markdown rendering, `<ChatChart>` wrapper

**Monetization:**

| Tier | Web Messages | API Calls/Month | Streaming | Charts |
|------|-------------|----------------|-----------|--------|
| Free | 10/day | 0 | No | No |
| Pro ($29/mo) | 100/day | 1,000 | Yes | Yes |
| Enterprise ($199/mo) | Unlimited | 50,000 | Yes | Yes |

---

### Phase 2: Intelligence (Q2–Q3 2026) — Pulse, Screener, Dashboards

#### 2.1 Agent "Pulse" — Personalized Market Digest

**Vision:** Every morning at 7:30 AM AEST, Pro subscribers receive a bespoke briefing tailored to their portfolio, watchlist, and interests. Not a generic newsletter — *their* market analyst.

**Features:**
- [ ] **Daily personalized email digest** — dual-LLM pipeline (reuse `weekly-report-generator` pattern) with user-specific context. Sections: Your Portfolio Today, Watchlist Alerts, Market Signal, Upcoming Events
- [ ] **Push notifications** — Firebase Cloud Messaging for short squeeze signals, director trades on portfolio stocks, short interest spikes > threshold
- [ ] **Configurable alert thresholds** — "Alert me when any watchlist stock's short interest changes > X% in a day"
- [ ] **"Why is this stock moving?" auto-analysis** — triggered on significant moves, combines short data + price + news + sector trends into a single paragraph
- [ ] **Weekly portfolio short risk score** — "Your portfolio has 23% exposure to heavily shorted stocks"
- [ ] **Server-side portfolio/watchlist migration** — move from localStorage to PostgreSQL (critical dependency)

**Architecture:**
- New tables: `user_preferences`, `user_watchlist`, `user_portfolio`, `pulse_history`
- New service: `services/pulse-generator/` (Go, Cloud Run Job, daily 7:00 AM AEST)
- Event-driven alerts: `news-ingested` topic → `alert-evaluator` service → `alerts` topic → `alert-dispatcher` service
- Email: SendGrid or Resend API. Push: Firebase Cloud Messaging
- New RPCs: `GetMyPulse(date)`, `UpdateAlertPreferences`, `GetAlertHistory`
- Implement existing `DashboardService` proto (already defined in `proto/shortedapi/dashboard/v1/dashboard.proto`, never built) for server-side persistence
- Frontend: `/settings/alerts`, `/pulse` archive, notification bell with unread count

**Monetization:** Free = weekly summary only. Pro = daily Pulse, alerts, push notifications. Enterprise = unlimited rules, white-label digest.

---

#### 2.2 Stock Screener & Enhanced Dashboards

**Vision:** Professional-grade analysis workstation. Screener presets become shareable social objects that seed community engagement.

**Features:**
- [ ] **Compound filter screener** — short interest range, change over period, market cap, industry, P/E, dividend yield, director activity, news sentiment. Sortable, paginated results.
- [ ] **Shareable screener presets** — save, share via URL, community voting. Pre-built: "Short Squeeze Candidates" (>15% short, declining, price rising), "Dividend Aristocrats Under Pressure", "Small Cap Bears"
- [ ] **Dashboard templates** — pre-built layouts: "Day Trader", "Income Investor", "Short Specialist"
- [ ] **Heatmap widget** — entire ASX by market cap tiles, colored by short interest (finviz-style)
- [ ] **Multi-timeframe chart overlay** — same stock across 1m, 3m, 1y side-by-side
- [ ] **Server-side dashboard persistence** — implement existing `DashboardService` proto, enables cross-device sync and sharing

**Architecture:**
- New pre-computed table: `stock_daily_snapshot` — one row per stock per day with all screener metrics joined (updated by daily sync)
- New RPC: `ScreenStocks(ScreenRequest)` with `FilterCriteria[]` → dynamic SQL against snapshot table
- Implement `DashboardService` proto (already in `proto/shortedapi/dashboard/v1/dashboard.proto`)
- New widgets in `widget-registry.ts`: `SCREENER`, `HEATMAP`, `NEWS_FEED`, `DIVIDEND_CALENDAR`
- Frontend: `/screener` page with filter builder (shadcn Select, Slider), CSV export, "Share" button

**Monetization:** Free = 3 filters, 2 widgets. Pro = unlimited filters/widgets, sharing, CSV export. Enterprise = API screener access, webhook triggers.

---

### Phase 3: Community (Q3–Q4 2026) — Forum, Social, Predictions

#### 3.1 Community Forum — "Shorted Talk"

**Vision:** Not a generic forum — a data-integrated discussion platform. Every post tagged to a stock auto-shows current short %, price action, and latest announcements. HotCopper meets Bloomberg.

**Features:**
- [ ] **Stock-linked threads** — tag posts to stock codes, auto-show live data in thread header
- [ ] **Market-wide rooms** — "Daily Market Discussion" (auto-created each trading day), "Weekly Report Discussion", rotating "Sector Spotlight"
- [ ] **Data-backed posts** — embed live stock charts, short comparisons, screener results in post body
- [ ] **Reputation system** — earn from upvotes, prediction accuracy, posting quality. Unlocks: flair, early access, moderation powers
- [ ] **Prediction market (paper-only)** — "I predict BHP short interest will exceed 8% by March 30." System tracks against actual data, displays accuracy on profiles. "Proven Analyst" badge for high accuracy.
- [ ] **Community sentiment gauge** — aggregate per-stock sentiment from posts, weighted by reputation, displayed on stock pages
- [ ] **Expert AMAs** — scheduled Q&A sessions with analysts/fund managers, with live data overlays
- [ ] **Moderation pipeline** — LLM-based spam/financial-advice detection (Gemini Flash), auto-flag for review

**Architecture:**
- New service: `services/forum/` (Go, Cloud Run, separate from shorts API)
- New tables: `forum_posts`, `forum_comments`, `user_reputation`, `predictions`
- Real-time: Pub/Sub `forum-events` topic → SSE or polling on frontend (WebSocket later)
- Moderation: `moderation-queue` Pub/Sub topic, LLM classifier, admin review dashboard
- New proto: `ForumService` — `CreatePost`, `GetPost`, `ListPosts`, `Vote`, `CreatePrediction`, `GetUserReputation`
- Frontend: `/community` route tree — feed, stock-specific threads, user profiles with prediction history

**Monetization:** Free = read-only, 1 post/day. Pro = unlimited posting, predictions, data embeds. Enterprise = sentiment aggregation API.

**Regulatory note:** Australian financial regulations require disclaimers on content that could be construed as financial advice. Auto-insert disclaimers on all forum posts.

---

#### 3.2 Social Features & User-Generated Content

**Features:**
- [ ] Public investor profiles (opt-in) — reputation, prediction accuracy, shared screeners, badges
- [ ] Follow system (one-way, like Twitter)
- [ ] Collaborative watchlists — shared between investing clubs
- [ ] "Trade ideas" structured posts — stock, direction, thesis, time horizon, auto-tracked against performance
- [ ] User-contributed stock analyses — quality-scored by community votes, featured alongside AI analysis on stock pages

---

### Phase 4: Transparency (Q4 2026 – Q1 2027) — Vigilante Data, Economic Context

#### 4.1 "Shorted Transparency" — Accountability Data

**Vision:** Cross-reference corporate tax, emissions, and mining royalties with short selling data. "Company X paid $0 tax on $2B profit — and their short interest just doubled." The feature that earns media coverage and defines the brand.

**Features:**
- [ ] **Corporate tax transparency dashboard** — ATO data for entities >$100M income. Per stock: total income, taxable income, tax payable, effective rate. Rank by "tax gap." Overlay with short interest.
- [ ] **Mining & petroleum royalty tracker** — WA DMIRS, QLD Treasury, NSW Mining royalty data vs. revenue. "Is the market pricing in royalty reform risk?"
- [ ] **Environmental emissions scoreboard** — Clean Energy Regulator NGER data mapped to ASX companies. Emissions, intensity, trend. "Carbon risk" treemap overlay.
- [ ] **Government contract exposure** — AusTender data cross-referenced with ASX companies.
- [ ] **"Follow the money" investigations** — pre-built analyses: "Banks: tax vs profits vs shorts", "Mining: royalties vs dividends vs emissions"
- [ ] **Transparency scores** — composite per-company score (tax rate vs peers, emissions reporting, disclosure timeliness)
- [ ] **Media partnerships** — free API access for journalists, attribution in exchange

**Data sources:**

| Source | URL | Frequency |
|--------|-----|-----------|
| ATO Corporate Tax Transparency | `data.gov.au/dataset/corporate-transparency` | Annual |
| Clean Energy Regulator NGER | `cleanenergyregulator.gov.au/NGER` | Annual |
| WA DMIRS Royalties | `dmp.wa.gov.au/About-Us/Royalty-data` | Annual |
| QLD Treasury Royalties | `treasury.qld.gov.au/resource/royalty-statistics/` | Annual |
| AusTender (Federal) | `tenders.gov.au` | Ongoing |
| APRA Banking Statistics | `apra.gov.au/quarterly-authorised-deposit-taking-institution-statistics` | Quarterly |
| AEMO Electricity Market | `aemo.com.au/energy-systems/electricity` | Daily |

**Architecture:**
- New service: `services/transparency-sync/` (Go, Cloud Run Job, annual/quarterly)
- New tables: `corporate_tax`, `emissions_data`, `royalty_data`, `government_contracts`
- Critical: ABN-to-stock_code mapping table (`entity_stock_map`) — fuzzy match entity names to `company-metadata.company_name`, LLM disambiguation, manual curation for top 200
- New RPCs: `GetCorporateTaxData`, `GetEmissionsData`, `GetTransparencyScore`
- Frontend: `/transparency` route tree, new widgets: `TAX_TRANSPARENCY`, `EMISSIONS_OVERLAY`

---

#### 4.2 Consumer Trends & Economic Data — "Shorted Economy"

**Vision:** Macroeconomic context for why short positions move. ABS economic data, commodity prices, and consumer sentiment overlaid with sector short positions.

**Features:**
- [ ] **Economic indicators dashboard** — GDP, CPI, unemployment, consumer confidence, housing, retail sales with 5-year sparklines. Overlay with aggregate short interest.
- [ ] **Consumer sentiment tracker** — Westpac/Melbourne Institute index overlaid with retail sector shorts
- [ ] **Commodity price feeds** — iron ore, gold, lithium, coal, gas overlaid with resource sector shorts
- [ ] **Interest rate scenario modelling** — "What happens to bank shorts when rates change?" Historical correlation analysis + user-adjustable scenarios
- [ ] **Housing market data** — CoreLogic indices alongside bank/REIT short positions
- [ ] **Employment data by sector** — ABS quarterly, mapped to GICS sectors

**Data sources:**

| Source | URL | Notes |
|--------|-----|-------|
| ABS API | `api.data.abs.gov.au` | CPI (6401.0), Labour (6202.0), Retail (8501.0), GDP (5206.0) |
| RBA Statistics | `rba.gov.au/statistics/tables/` | Rates, monetary aggregates, FX |
| Commodity Prices | Yahoo Finance (already integrated) | ASX commodity ETFs |
| Consumer Sentiment | Westpac/Melbourne Institute | Monthly release |

**Architecture:**
- New service: `services/economic-data-sync/` (Go, Cloud Run Job, monthly + daily for commodities)
- New table: `economic_indicators` (indicator_name, date, value, source, category)
- ABS API client: JSON-stat format via `api.data.abs.gov.au/data/{dataflow}/{key}?format=jsondata`
- New RPCs: `GetEconomicIndicators`, `GetSectorCorrelation(indicator, sector, period)`
- Frontend: `/economy` route, new widgets: `ECONOMIC_INDICATORS`, `COMMODITY_PRICES`, `MACRO_CORRELATION`

---

### Additional Data Sources Summary

| Category | Source | What It Provides | Phase |
|----------|--------|-----------------|-------|
| **Short selling** | ASIC (existing) | Daily short positions | Already live |
| **Prices** | Yahoo Finance (existing) | OHLCV history | Already live |
| **Company data** | LLM enrichment (existing) | Summaries, people, risks | Already live |
| **News** | AFR, Stockhead, Livewire, ASX | Multi-source news | Phase 1 |
| **Insider trading** | ASX Appendix 3Y | Director buy/sell | Phase 1 |
| **Dividends** | ASX Appendix 3A.1 | Yield, ex-dates, history | Phase 1 |
| **Interest rates** | RBA Table A2 | Cash rate decisions | Phase 1 |
| **Corporate tax** | ATO Transparency | Tax paid vs income | Phase 4 |
| **Emissions** | Clean Energy Regulator | Scope 1 & 2 emissions | Phase 4 |
| **Mining royalties** | State treasuries | Royalties paid vs revenue | Phase 4 |
| **Govt contracts** | AusTender | Contract values by company | Phase 4 |
| **Banking stats** | APRA | Capital ratios, lending | Phase 4 |
| **Economic data** | ABS API | GDP, CPI, employment, retail | Phase 4 |
| **Electricity market** | AEMO | Wholesale prices | Phase 4 |
| **Commodities** | Yahoo Finance (extend) | Iron ore, gold, lithium | Phase 4 |
| **Consumer sentiment** | Westpac/MI, ANZ-Roy Morgan | Monthly confidence index | Phase 4 |
| **Housing** | CoreLogic | Capital city indices | Phase 4 |
| **Options/derivatives** | ASX | Put/call ratios (future) | Future |
| **Substantial holders** | ASX announcements | Institutional ownership | Phase 1 |

---

### Revenue Model Evolution

| Current | Phase 1–2 | Phase 3–4 |
|---------|-----------|-----------|
| Free / Pro / Enterprise | + Chat API tiers | + Community Pro |
| Rate-limited API | + News API | + Transparency API |
| $0 / $29 / $199 | + Chat: $29–$199/mo | + Data Partner: custom |

**New revenue streams:**
- Chat API (per-message or per-conversation pricing)
- Transparency data API (ESG research firms, journalists)
- Community Pro tier (predictions, unlimited posting)
- Media partnerships (free data for attribution — brand building)
- Enterprise white-label Pulse digests (for financial advisors)

---

### Data Richness: Enrichment Processor & News Aggregator Fixes

**Goal:** Ensure every stock page has rich, reliable data — not just short positions.

#### Tier 1: Quick Wins (< 1 day each)

- [ ] **Add Cloud Scheduler for enrichment auto-runs** — currently enrichment only runs when manually triggered via `/enrich-batch`. Add a daily `priority=unenriched` run and weekly `priority=stale` run via Cloud Scheduler.
- [ ] **Add `GEMINI_API_KEY` to news-aggregator Terraform** — the env var is missing from `terraform/modules/news-aggregator/main.tf`, so production likely uses the crude 9-keyword sentiment fallback instead of Gemini Flash.
- [ ] **Fix `AnalyzeBatch` called one article at a time** — `services/news-aggregator/store.go` calls `AnalyzeBatch` in a loop with single headlines. Pass all headlines in one call.
- [ ] **Surface key people images on frontend** — `web/src/app/actions/company-metadata.ts` `convertKeyPeople()` drops `image_gcs_url`, `linkedin_url`, `source_url`, `source_type` that the backend populates. Add these fields.
- [ ] **Show key metrics on stock Overview tab** — `CompanyFinancials` (market cap, PE, EPS) only renders in the "Financials" tab, not Overview. Most users never see it.
- [ ] **Fix peer comparison `price_change_1m` always zero** — `services/shorts/internal/store/shorts/postgres_peers.go` scans 7 columns but proto defines 8 fields. `PriceChange1M` is never populated.
- [ ] **Fix `total_count` bug in news API** — `GetStockNews` returns `len(articles)` as total, not the actual DB count. Pagination would be broken.
- [ ] **Fix `is_price_sensitive` always false** — never set by any RSS source, making `BreakingNewsBanner` permanently empty.
- [ ] **Fix trailing yield calculation** — `postgres_dividends.go` sums all dividends up to 5 years instead of TTM.

#### Tier 2: Fill Empty Tables (1–3 days each)

- [ ] **Build director trades ingestion** — schema + store exist (migration 000024, `postgres_directors.go`) but no service populates them. Parse ASX Appendix 3Y announcements.
- [ ] **Build dividend history ingestion** — schema + store exist (migration 000025, `postgres_dividends.go`) but no ingestion service. Source from Yahoo Finance or ASX data.
- [ ] **Add ASX announcements as RSS/API source** — the most relevant per-stock news source isn't in the news aggregator's 4 RSS feeds.
- [ ] **Fix news stock matching false positives** — first-word company name indexing causes matches like "National" → NAB. Add fuzzy matching and match article bodies, not just headlines.
- [ ] **Wire up news article tags** — `tags` column is always `[]`. Add topic/event classification in the sentiment analysis step.
- [ ] **Wire up `relevance_score` properly** — hardcoded 0.5 for all articles. `IsTrusted` flag on sources is defined but never consumed.

#### Tier 3: New Data Dimensions

- [ ] **Financial data parsing** — extract revenue/NPAT/EPS trends from annual reports (enrichment already crawls PDF links but doesn't parse them).
- [ ] **Analyst consensus integration** — price targets and buy/hold/sell ratings from a data provider.
- [ ] **Ownership data** — institutional holders, substantial shareholder notices from ASX.
- [ ] **Earnings calendar** — when the next report is due, from ASX announcements.
- [ ] **Auto-refresh stale enrichments** — staleness threshold is 30 days but `priority=stale` must be manually triggered. Wire into the scheduled run.
- [ ] **Deterministic quality scoring** — enrichment quality `overall_score` weighting is decided by the LLM each call. Use a fixed formula instead.
- [ ] **Add more RSS sources** — only 4 feeds (Stockhead, Livewire, Market Index, Small Caps). Missing AFR, Reuters AU, ASX announcements.

---

### What Makes This "Bloomberg Terminal for Retail"

1. **Data moat** — 15 years of ASIC short data cross-referenced with tax, emissions, insider trading. Cannot be replicated quickly.
2. **AI that knows Australia** — function-calling over proprietary data, not a generic GPT wrapper.
3. **Community network effects** — shared screeners, predictions with tracking, stock-linked discussion.
4. **Transparency brand** — civic technology positioning earns media coverage and trust.
5. **Full research workflow** — Data → Analysis → Intelligence → Discussion → Accountability in one platform.
