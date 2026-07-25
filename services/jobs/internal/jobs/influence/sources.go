package influence

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type IndustrySourceDefinition struct {
	SourceKey           string
	DisplayName         string
	SignalKind          string
	Publisher           string
	SourceURL           string
	Licence             string
	Cadence             string
	CollectionMethod    string
	Enabled             bool
	PublicEnabled       bool
	ExactEntityRequired bool
	Notes               string
	ProbeURL            string
}

var industrySourceDefinitions = []IndustrySourceDefinition{
	{
		SourceKey:           "asic-short-interest",
		DisplayName:         "ASIC short position reports",
		SignalKind:          "short_interest",
		Publisher:           "Australian Securities and Investments Commission",
		SourceURL:           "https://asic.gov.au/regulatory-resources/markets/short-selling/short-position-reports-table/",
		Licence:             "ASIC website terms",
		Cadence:             "Daily, T+4",
		CollectionMethod:    "download",
		Enabled:             true,
		PublicEnabled:       true,
		ExactEntityRequired: false,
		Notes:               "Existing live short-interest layer.",
	},
	{
		SourceKey:           "ato-corporate-tax-transparency",
		DisplayName:         "ATO Corporate Tax Transparency",
		SignalKind:          "tax_environment",
		Publisher:           "Australian Taxation Office",
		SourceURL:           "https://data.gov.au/data/dataset/corporate-transparency",
		Licence:             "CC-BY-3.0-AU",
		Cadence:             "Annual",
		CollectionMethod:    "ckan",
		Enabled:             true,
		PublicEnabled:       true,
		ExactEntityRequired: true,
		Notes:               "Imported through the influence collector and exact ASX entity mapping.",
		ProbeURL:            ckanPackageURL,
	},
	{
		SourceKey:           "abs-international-trade-goods",
		DisplayName:         "International Trade in Goods",
		SignalKind:          "trade_exposure",
		Publisher:           "Australian Bureau of Statistics",
		SourceURL:           "https://www.abs.gov.au/statistics/economy/international-trade/international-trade-goods/latest-release",
		Licence:             "CC-BY-4.0",
		Cadence:             "Monthly",
		CollectionMethod:    "download",
		Enabled:             true,
		ExactEntityRequired: false,
		Notes:               "Industry-level figures only via the reviewed commodity-to-industry crosswalk; no entity-level claims.",
	},
	{
		SourceKey:           "abs-input-output-tables",
		DisplayName:         "Australian National Accounts Input-Output Tables",
		SignalKind:          "trade_exposure",
		Publisher:           "Australian Bureau of Statistics",
		SourceURL:           "https://www.abs.gov.au/statistics/economy/national-accounts/australian-national-accounts-input-output-tables/latest-release",
		Licence:             "ABS website terms",
		Cadence:             "Annual",
		CollectionMethod:    "download",
		Enabled:             true,
		ExactEntityRequired: true,
		Notes:               "Industry exposure backbone for imports, exports, intermediate use, and taxes less subsidies.",
	},
	{
		SourceKey:           "austender-contract-notices",
		DisplayName:         "AusTender Contract Notice Export",
		SignalKind:          "public_money",
		Publisher:           "Department of Finance",
		SourceURL:           "https://data.gov.au/data/dataset/austender-contract-notice-export",
		Licence:             "CC-BY-3.0-AU",
		Cadence:             "Daily export",
		CollectionMethod:    "ckan",
		Enabled:             true,
		ExactEntityRequired: true,
		Notes:               "Contract notices need exact ABN/entity resolution before public company-level surfacing.",
		ProbeURL:            "https://data.gov.au/data/api/3/action/package_show?id=austender-contract-notice-export",
	},
	{
		SourceKey:           "grantconnect-awards",
		DisplayName:         "GrantConnect grants awarded",
		SignalKind:          "public_money",
		Publisher:           "Department of Finance",
		SourceURL:           "https://www.grants.gov.au/",
		Licence:             "GrantConnect website terms",
		Cadence:             "Daily",
		CollectionMethod:    "html",
		Enabled:             true,
		ExactEntityRequired: true,
		Notes:               "Grant awards need exact ABN/entity resolution before public company-level surfacing.",
	},
	{
		SourceKey:           "aec-transparency-register",
		DisplayName:         "AEC Transparency Register",
		SignalKind:          "policy_footprint",
		Publisher:           "Australian Electoral Commission",
		SourceURL:           "https://transparency.aec.gov.au/",
		Licence:             "AEC website terms",
		Cadence:             "Annual/election returns",
		CollectionMethod:    "download",
		Enabled:             true,
		ExactEntityRequired: true,
		Notes:               "Disclosure data needs exact donor/entity resolution and neutral labels.",
	},
	{
		SourceKey:           "agd-register-lobbyists",
		DisplayName:         "Australian Government Register of Lobbyists",
		SignalKind:          "policy_footprint",
		Publisher:           "Attorney-General's Department",
		SourceURL:           "https://www.ag.gov.au/integrity/australian-government-register-lobbyists",
		Licence:             "AGD website terms",
		Cadence:             "Register updates",
		CollectionMethod:    "html",
		Enabled:             true,
		ExactEntityRequired: true,
		Notes:               "Register/client records require exact entity matching before public surfacing.",
	},
	{
		SourceKey:           "agd-fits-register",
		DisplayName:         "Foreign Influence Transparency Scheme Register",
		SignalKind:          "policy_footprint",
		Publisher:           "Attorney-General's Department",
		SourceURL:           "https://www.ag.gov.au/integrity/foreign-influence-transparency-scheme",
		Licence:             "AGD website terms",
		Cadence:             "Register updates",
		CollectionMethod:    "html",
		Enabled:             true,
		ExactEntityRequired: true,
		Notes:               "Foreign influence records require exact entity matching and review before public surfacing.",
	},
	{
		SourceKey:           "cer-nger-corporate-emissions",
		DisplayName:         "NGER corporate emissions and energy data",
		SignalKind:          "emissions",
		Publisher:           "Clean Energy Regulator",
		SourceURL:           "https://cer.gov.au/markets/reports-and-data/nger-reporting-data-and-registers",
		Licence:             "CER website terms",
		Cadence:             "Annual",
		CollectionMethod:    "download",
		Enabled:             true,
		ExactEntityRequired: true,
		Notes:               "Corporate emissions records require exact controlling-corporation mapping before public surfacing.",
		ProbeURL:            cerLatestURL,
	},
}

func probeURLForSource(source IndustrySourceDefinition) string {
	if source.ProbeURL != "" {
		return source.ProbeURL
	}
	return source.SourceURL
}

func probeIndustrySource(ctx context.Context, client *http.Client, source IndustrySourceDefinition) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, probeURLForSource(source), nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("User-Agent", influenceUA)
	req.Header.Set("Accept", "text/html,application/json;q=0.9,*/*;q=0.8")

	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer func() { _ = resp.Body.Close() }()

	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 2048))
	if resp.StatusCode < 200 || resp.StatusCode >= 400 {
		return resp.StatusCode, fmt.Errorf("%s returned HTTP %d", source.SourceKey, resp.StatusCode)
	}
	return resp.StatusCode, nil
}

func classifyProbeStatus(err error) string {
	if err == nil {
		return "succeeded"
	}
	return "failed"
}

func compactError(err error) string {
	if err == nil {
		return ""
	}
	msg := strings.TrimSpace(err.Error())
	if len(msg) > 500 {
		return msg[:500]
	}
	return msg
}

func newProbeHTTPClient() *http.Client {
	return &http.Client{Timeout: 45 * time.Second}
}
