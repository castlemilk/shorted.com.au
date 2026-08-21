package jobmonitor

import "strings"

// catalog.go holds the ONLY hand-maintained knowledge in this package.
//
// Discovery itself is fully dynamic — jobmonitor lists whatever Cloud Run Jobs
// and Cloud Scheduler triggers exist in the project, so a new job appears on the
// dashboard the moment it is deployed, with no code change. The catalog only
// *decorates* what discovery finds:
//
//   - a human display name and category, so the console groups the fleet the way
//     an operator thinks about it rather than by the accident of a resource name;
//   - a RETIRED marker for jobs that are deliberately deployed-but-unscheduled
//     (superseded by the consolidated `shorted <job>` binary), so their paused
//     scheduler reads as "retired by design" instead of a permanent amber alarm;
//   - a FALLBACK cadence for a job that has no Cloud Scheduler trigger at all
//     (operator-invoked, or triggered by something other than Cloud Scheduler),
//     so "overdue" can still be computed.
//
// An unknown job is NOT hidden — it falls through to humanize()/categoryFor()
// and renders with a derived name. Missing catalog entries degrade the label,
// never the visibility.
//
// Fleet verified against prod (rosy-clover-477102-t5) on 2026-08-21:
//
//	australia-southeast2 jobs: director-trade-extractor, financial-report-extractor,
//	  house-price-collector, influence-collector, shorted-announcements,
//	  shorted-economy, shorted-news, shorted-signals, shorted-weekly-report,
//	  shorts-data-sync, signals-collector, weekly-report-generator
//	us-central1 jobs: asx-discovery
//	scheduler-only (target HTTP services, not Cloud Run Jobs): market-data-sync-daily,
//	  stock-price-daily-sync, stock-price-weekly-sync, key-metrics-daily-sync
type catalogEntry struct {
	// DisplayName overrides the derived title-cased resource name.
	DisplayName string
	// Category groups the row in the console.
	Category string
	// Note is operator context shown under the job name (why it is retired, what
	// it was replaced by, how it is triggered).
	Note string
	// Retired marks a job that is deployed and manually executable but has no
	// live schedule BY DESIGN. Retired jobs never raise the fleet alarm and sort
	// to the bottom of the table.
	Retired bool
	// FallbackCron supplies the cadence when no Cloud Scheduler trigger matches
	// this job. Sourced from terraform (see the per-entry comment); live scheduler
	// cron always wins over this.
	FallbackCron string
}

// catalog maps a Cloud Run Job / Cloud Scheduler resource name to its decoration.
// Cadences quoted in Notes come from terraform/environments/prod/main.tf unless
// stated otherwise; the live Cloud Scheduler cron is what the dashboard actually
// renders, so these comments are provenance, not configuration.
var catalog = map[string]catalogEntry{
	// --- Consolidated `shorted <job>` binary (services/jobs, July 2026) ---------
	"shorted-announcements": {
		DisplayName: "ASX Announcements",
		Category:    "Filings & reports",
		Note:        "`shorted announcements` — consolidated jobs binary",
	},
	"shorted-economy": {
		DisplayName: "Economy Collector",
		Category:    "Economy",
		Note:        "`shorted economy -mode all` — 11 ABS/RBA sources; replaced economy-collector",
	},
	"shorted-news": {
		DisplayName: "News Aggregator",
		Category:    "News",
		// FIVE schedulers on one job (aggregate + cluster + digest + backfill-images
		// + resolve-googlenews); all of them are listed in JobStatus.Triggers.
		Note: "`shorted news` — one job, five schedules (aggregate/cluster/digest/images/resolve)",
	},
	"shorted-signals": {
		DisplayName: "Risk Signals",
		Category:    "Signals",
		Note:        "`shorted signals` — brandbrain grounded signals; replaced signals-collector",
	},
	"shorted-weekly-report": {
		DisplayName: "Weekly & Monthly Reports",
		Category:    "Reports",
		// Two schedulers on one job: weekly (Fri) + monthly (1st, REPORT_TYPE override).
		Note: "`shorted weekly-report` — weekly + monthly on one job; replaced weekly-report-generator",
	},

	// --- Surviving standalone jobs ---------------------------------------------
	"shorts-data-sync": {
		DisplayName: "Short Positions Sync",
		Category:    "Market data",
		Note:        "ASIC daily short positions — the deepest signal is the sync_status row below",
	},
	"house-price-collector": {
		DisplayName: "House Price Collector",
		Category:    "Housing",
		// Two schedulers: monthly official ingest + a daily drop-index pass.
		Note: "Official ABS/RBA/VG ingest (monthly) + drop-index rebuild (daily)",
	},
	"influence-collector": {
		DisplayName: "Influence Collector",
		Category:    "Influence",
		Note:        "ATO/CER/AusTender/AEC feeds; the APH register crawl is operator-invoked only",
	},
	"asx-discovery": {
		DisplayName: "ASX Discovery",
		Category:    "Market data",
		// Deployed to us-central1 for Tier-1 pricing — invisible to a
		// single-region collector, which is why RunRegions is a list.
		Note: "Runs in us-central1 (Tier 1 pricing)",
	},
	"director-trade-extractor": {
		DisplayName: "Director Trade Extractor",
		Category:    "Filings & reports",
	},
	"financial-report-extractor": {
		DisplayName: "Financial Report Extractor",
		Category:    "Filings & reports",
	},

	// --- Retired: deployed + manually executable, schedulers paused ON PURPOSE --
	// terraform/environments/prod/main.tf marks both modules SUPERSEDED and sets
	// scheduler_paused = true (rollback = flip that flag back).
	"signals-collector": {
		DisplayName: "Risk Signals (legacy)",
		Category:    "Signals",
		Note:        "Retired — superseded by shorted-signals; kept for manual rollback",
		Retired:     true,
	},
	"weekly-report-generator": {
		DisplayName: "Weekly Reports (legacy)",
		Category:    "Reports",
		Note:        "Retired — superseded by shorted-weekly-report; kept for manual rollback",
		Retired:     true,
	},

	// --- Scheduler-only rows: these trigger HTTP SERVICES, not Cloud Run Jobs ---
	// They have no execution history, so their status is trigger-level only
	// ("the request was accepted"), not "the work succeeded".
	"market-data-sync-daily": {
		DisplayName: "Market Data Sync",
		Category:    "Market data",
		Note:        "Scheduler → market-data service; status is trigger-level only",
	},
	"stock-price-daily-sync": {
		DisplayName: "Stock Prices — Daily",
		Category:    "Market data",
		Note:        "Scheduler → stock-price-ingestion service; status is trigger-level only",
	},
	"stock-price-weekly-sync": {
		DisplayName: "Stock Prices — Weekly Backfill",
		Category:    "Market data",
		Note:        "Scheduler → stock-price-ingestion service; status is trigger-level only",
	},
	"key-metrics-daily-sync": {
		DisplayName: "Key Metrics Sync",
		Category:    "Market data",
		Note:        "Scheduler → market-data service; status is trigger-level only",
	},
}

// decorate applies the catalog entry (if any) to a freshly discovered status,
// falling back to the derived name/category for anything not catalogued.
func decorate(st *JobStatus) {
	entry, ok := catalog[st.Name]
	if !ok {
		if st.DisplayName == "" {
			st.DisplayName = humanize(st.Name)
		}
		if st.Category == "" {
			st.Category = categoryFor(st.Name)
		}
		return
	}
	st.DisplayName = firstNonEmpty(entry.DisplayName, humanize(st.Name))
	st.Category = firstNonEmpty(entry.Category, categoryFor(st.Name))
	st.Note = entry.Note
	st.Retired = entry.Retired
}

// fallbackCron returns the catalog cadence for a job with no scheduler trigger.
func fallbackCron(name string) string {
	if entry, ok := catalog[name]; ok {
		return entry.FallbackCron
	}
	return ""
}

// categoryFor derives a category for a job the catalog doesn't know about. Kept
// deliberately coarse — a wrong-but-plausible group beats an unlabelled row.
func categoryFor(name string) string {
	switch {
	case strings.Contains(name, "hous") || strings.Contains(name, "price-drop") || strings.Contains(name, "crawl"):
		return "Housing"
	case strings.Contains(name, "econom"):
		return "Economy"
	case strings.Contains(name, "influence") || strings.Contains(name, "politic") || strings.Contains(name, "register"):
		return "Influence"
	case strings.Contains(name, "report") && !strings.Contains(name, "financial-report"):
		return "Reports"
	case strings.Contains(name, "news"):
		return "News"
	case strings.Contains(name, "signal"):
		return "Signals"
	case strings.Contains(name, "director") || strings.Contains(name, "announcement") || strings.Contains(name, "financial"):
		return "Filings & reports"
	case strings.Contains(name, "short") || strings.Contains(name, "market-data") ||
		strings.Contains(name, "stock-price") || strings.Contains(name, "key-metrics") ||
		strings.Contains(name, "discovery") || strings.Contains(name, "enrichment"):
		return "Market data"
	default:
		return "Other"
	}
}
