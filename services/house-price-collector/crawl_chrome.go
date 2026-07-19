package main

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// crawl_chrome.go owns the DEDICATED-profile Chrome lifecycle for -mode agent:
// keeping it reachable over CDP and its Kasada session warm, WITHOUT an external
// shell wrapper. It is a Go port of deploy/run-housing-agent.sh's warm_chrome /
// recover_wedged_chrome / warmcheck-loop logic. It only ever touches the
// dedicated --user-data-dir profile, NEVER the operator's personal Chrome.

// chromeCDPPort extracts the TCP port from a CDP URL (e.g. http://localhost:9333
// -> "9333"), used to build Chrome's --remote-debugging-port launch arg.
func chromeCDPPort(cdpURL string) (string, error) {
	if cdpURL == "" {
		return "", fmt.Errorf("empty CDP URL")
	}
	u, err := url.Parse(cdpURL)
	if err != nil {
		return "", fmt.Errorf("parse CDP URL %q: %w", cdpURL, err)
	}
	if u.Port() == "" {
		return "", fmt.Errorf("CDP URL %q has no port", cdpURL)
	}
	return u.Port(), nil
}

// matchDedicatedPIDs returns the PIDs from `ps -axww -o pid=,command=` output whose
// command line contains the EXACT `--user-data-dir=<profileDir>` flag. This is the
// only Chrome that carries the dedicated data dir, so the personal Chrome is never
// matched. An empty profileDir matches nothing (never "every Chrome"). Lines that
// are the grep/ps pipeline itself are excluded.
func matchDedicatedPIDs(psOutput, profileDir string) []int {
	if strings.TrimSpace(profileDir) == "" {
		return nil
	}
	needle := "--user-data-dir=" + profileDir
	var pids []int
	for _, line := range strings.Split(psOutput, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.Contains(line, needle) {
			continue
		}
		if strings.Contains(line, "grep ") || strings.HasPrefix(line, "grep") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		pids = append(pids, pid)
	}
	return pids
}

// chromeConfig is the dedicated-Chrome lifecycle config for -mode agent.
type chromeConfig struct {
	bin        string // HOUSING_CRAWL_CHROME_BIN — Chrome executable
	profileDir string // HOUSING_CRAWL_CHROME_PROFILE — dedicated --user-data-dir
	cdpURL     string // from crawlConfig.cdpURL (CRAWL_CDP_URL)
	autoWarm   bool   // CRAWL_AUTO_WARM (default true) — self-warm before crawling
	startURL   string // REA startup URL whose native nav clears Kasada
}

const defaultChromeBin = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

// loadChromeConfig reads the dedicated-Chrome config, mirroring the defaults in
// deploy/run-housing-agent.sh. cdpURL is threaded in from the crawl config.
func loadChromeConfig(cdpURL string) chromeConfig {
	home, _ := os.UserHomeDir()
	return chromeConfig{
		bin:        envStr("HOUSING_CRAWL_CHROME_BIN", defaultChromeBin),
		profileDir: envStr("HOUSING_CRAWL_CHROME_PROFILE", filepath.Join(home, ".shorted-housing-crawl-chrome")),
		cdpURL:     cdpURL,
		autoWarm:   envStr("CRAWL_AUTO_WARM", "true") != "false",
		startURL:   "https://www.realestate.com.au/",
	}
}
