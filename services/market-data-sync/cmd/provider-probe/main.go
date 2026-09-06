// provider-probe asks a market-data provider whether it holds history for a
// list of codes, and writes nothing (#576).
//
// It exists because the question it answers had been argued rather than
// measured. #576 reported that 936 of 1,941 codes in the point-in-time universe
// carry no price history, and the standing explanation was that Yahoo drops
// delisted ASX tickers. That explanation was never tested — the backfill's
// stock list was derived from stock_prices itself, so a code with no prices was
// never requested, and "the provider has nothing" was indistinguishable from
// "we never asked".
//
// The measurement, taken 2026-09-06 against the 13 codes #576 names:
//
//	A2B A40 AB1 ABC ABP ADI AGG AHY AJM ALG API AQG ARQ  →  0 records, all 13
//	BHP CBA CSL (controls)                               →  3,040 records each
//
// Yahoo's own response for ABC.AX and API.AX is
// `{"code":"Not Found","description":"No data found, symbol may be delisted"}`,
// so the empty result is the provider's answer and not an artifact of how the
// request was shaped. The standing explanation was correct.
//
// Controls are the point. A run that returns nothing for every code is
// indistinguishable from a broken probe, so always pass a few codes known to be
// live alongside the ones under test.
//
// Usage:
//
//	go run ./cmd/provider-probe -codes ABC,API,BHP -years 12
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/castlemilk/shorted.com.au/services/market-data-sync/config"
	"github.com/castlemilk/shorted.com.au/services/market-data-sync/providers"
)

func main() {
	codes := flag.String("codes", "", "comma-separated ASX codes; include a few live ones as controls")
	years := flag.Int("years", 12, "how far back to ask")
	useAlphaVantage := flag.Bool("alpha-vantage", false, "probe Alpha Vantage instead of Yahoo (needs ALPHA_VANTAGE_API_KEY)")
	pause := flag.Duration("pause", 1500*time.Millisecond, "delay between codes, to stay under provider rate limits")
	flag.Parse()

	if strings.TrimSpace(*codes) == "" {
		fmt.Fprintln(os.Stderr, "-codes is required")
		os.Exit(2)
	}

	var provider providers.DataProvider = providers.NewYahooFinanceDirectProvider()
	if *useAlphaVantage {
		cfg := config.Load()
		if !cfg.HasAlphaVantage() {
			fmt.Fprintln(os.Stderr, "ALPHA_VANTAGE_API_KEY is not set")
			os.Exit(2)
		}
		provider = providers.NewAlphaVantageProvider(cfg.AlphaVantageAPIKey)
	}

	end := time.Now()
	start := end.AddDate(-*years, 0, 0)
	fmt.Printf("provider=%s window=%s..%s\n\n",
		provider.Name(), start.Format("2006-01-02"), end.Format("2006-01-02"))

	var recovered, empty, errored int
	for _, raw := range strings.Split(*codes, ",") {
		code := strings.ToUpper(strings.TrimSpace(raw))
		if code == "" {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		records, err := provider.FetchHistoricalData(ctx, code, start, end)
		cancel()

		switch {
		case err != nil:
			fmt.Printf("%-8s ERROR        %v\n", code, err)
			errored++
		case len(records) == 0:
			// The load-bearing outcome: asked, and the provider has nothing.
			fmt.Printf("%-8s UNAVAILABLE  0 records\n", code)
			empty++
		default:
			last := records[len(records)-1]
			fmt.Printf("%-8s RECOVERED    %d records  %s..%s  last close %.4f\n",
				code, len(records), records[0].Date.Format("2006-01-02"),
				last.Date.Format("2006-01-02"), last.Close)
			recovered++
		}
		time.Sleep(*pause)
	}

	fmt.Printf("\nrecovered=%d unavailable=%d error=%d\n", recovered, empty, errored)
	if recovered == 0 {
		fmt.Println("\nNo code returned data. If the list contained a known-live control, " +
			"this is a broken probe rather than a provider gap.")
	}
}
