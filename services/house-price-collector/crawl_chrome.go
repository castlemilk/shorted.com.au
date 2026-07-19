package main

import (
	"fmt"
	"net/url"
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
