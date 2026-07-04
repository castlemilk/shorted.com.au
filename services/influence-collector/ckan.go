package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// data.gov.au CKAN. The corporate-transparency package lists one resource per
// annual "Report of Entity Tax Information" (11 years, 2013-14 → 2023-24). A bare
// request is fine, but we send the project's influence-layer User-Agent for
// courtesy/traceability (same posture as the other collectors' fetches).
const (
	ckanPackageURL = "https://data.gov.au/data/api/3/action/package_show?id=corporate-transparency"
	influenceUA    = "shorted-influence/1.0 (+https://shorted.com.au)"

	taxSource        = "ato-corporate-tax-transparency"
	taxSourceLicence = "CC-BY-3.0-AU"
)

// ckanResource is one downloadable file in a CKAN package.
type ckanResource struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Format      string `json:"format"`
	URL         string `json:"url"`
}

type ckanPackageResponse struct {
	Success bool `json:"success"`
	Result  struct {
		Resources []ckanResource `json:"resources"`
	} `json:"result"`
}

// fetchTaxResources returns the annual report resources for the corporate tax
// transparency dataset via the CKAN package_show API.
func fetchTaxResources(ctx context.Context) ([]ckanResource, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ckanPackageURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", influenceUA)
	req.Header.Set("Accept", "application/json")

	resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("CKAN package_show: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var pkg ckanPackageResponse
	if err := json.NewDecoder(resp.Body).Decode(&pkg); err != nil {
		return nil, fmt.Errorf("decode CKAN response: %w", err)
	}
	if !pkg.Success {
		return nil, fmt.Errorf("CKAN package_show reported success=false")
	}
	return pkg.Result.Resources, nil
}

// downloadResource GETs a resource file into memory (files are ~0.3MB XLSX).
func downloadResource(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", influenceUA)

	resp, err := (&http.Client{Timeout: 120 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download %s: HTTP %d", url, resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}
