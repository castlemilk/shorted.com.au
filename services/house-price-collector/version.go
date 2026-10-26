package main

import (
	"encoding/json"
	"io"
	"runtime"
	"runtime/debug"
	"strings"
)

// collectorRevision is the git revision this binary was built from. Release
// builds stamp it with `-ldflags "-X main.collectorRevision=<sha>"`. A plain
// `go build` leaves it empty, and the toolchain's vcs.revision is used instead.
var collectorRevision string

// collectorVersion is the single JSON object `-mode version` prints.
type collectorVersion struct {
	Revision string `json:"revision"`
	Modified bool   `json:"modified"`
	Source   string `json:"source"`
	Go       string `json:"go"`
}

const (
	versionSourceLDFlags   = "ldflags"
	versionSourceBuildInfo = "buildinfo"
	versionSourceUnknown   = "unknown"
	versionRevisionUnknown = "unknown"
)

// resolveCollectorVersion is the pure resolution rule, kept free of globals so it
// is testable: an ldflags stamp wins; otherwise the build info's vcs.revision
// (and vcs.modified); otherwise "unknown". An ldflags stamp reports modified=false,
// because a stamped release is built from a clean checkout by construction.
func resolveCollectorVersion(ldflagsRevision string, info *debug.BuildInfo, goVersion string) collectorVersion {
	if rev := strings.TrimSpace(ldflagsRevision); rev != "" {
		return collectorVersion{Revision: rev, Modified: false, Source: versionSourceLDFlags, Go: goVersion}
	}
	if info != nil {
		var rev string
		var modified bool
		for _, s := range info.Settings {
			switch s.Key {
			case "vcs.revision":
				rev = s.Value
			case "vcs.modified":
				modified = s.Value == "true"
			}
		}
		if rev != "" {
			return collectorVersion{Revision: rev, Modified: modified, Source: versionSourceBuildInfo, Go: goVersion}
		}
	}
	return collectorVersion{Revision: versionRevisionUnknown, Modified: false, Source: versionSourceUnknown, Go: goVersion}
}

// runVersion writes the version as ONE JSON line and returns the exit code. It
// needs no environment at all, so it is dispatched before the DATABASE_URL check.
func runVersion(w io.Writer) int {
	info, _ := debug.ReadBuildInfo()
	v := resolveCollectorVersion(collectorRevision, info, runtime.Version())
	b, err := json.Marshal(v)
	if err != nil {
		return 1
	}
	if _, err := w.Write(append(b, '\n')); err != nil {
		return 1
	}
	return 0
}
