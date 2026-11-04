package engine

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
)

// engineGoldens are the goldens whose content is the engine's output. Their
// digest is recorded against each engine version. The spec goldens are not in
// it: a rules change is a new rules version, and an engine version changes only
// when the engine's output does.
var engineGoldens = []string{evaluateGoldenPath}

const versionHistoryPath = "testdata/version_history.golden"

// goldenDigest hashes the engine goldens in order, each under its path and
// length, so a change to any of them, or to their order, changes the digest.
func goldenDigest(t *testing.T) string {
	t.Helper()
	h := sha256.New()
	for _, p := range engineGoldens {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatalf("read engine golden %s: %v", p, err)
		}
		_, _ = fmt.Fprintf(h, "%s\n%d\n", p, len(b))
		_, _ = h.Write(b)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// parseSemver reads MAJOR.MINOR.PATCH.
func parseSemver(v string) ([3]int, bool) {
	var out [3]int
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

func cmpSemver(a, b [3]int) int {
	for i := range a {
		if a[i] != b[i] {
			if a[i] < b[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

// TestEngineVersionBumpedWithGoldens holds Version to the engine goldens. The
// history file records, for each engine version, the digest of the engine
// goldens it shipped with. Versions must strictly increase and never repeat a
// digest, and the newest line must be the current Version with the current
// digest. So an output change without a higher Version fails, and so does a
// bump that records no new digest or a digest recorded under an old version.
func TestEngineVersionBumpedWithGoldens(t *testing.T) {
	if !strings.HasPrefix(Version, fmt.Sprintf("%d.", Major)) {
		t.Fatalf("Version %q does not carry Major %d", Version, Major)
	}
	cur, ok := parseSemver(Version)
	if !ok {
		t.Fatalf("Version %q is not MAJOR.MINOR.PATCH", Version)
	}
	digest := goldenDigest(t)

	b, err := os.ReadFile(versionHistoryPath)
	if err != nil {
		t.Fatalf("open version history: %v", err)
	}
	type entry struct{ version, digest string }
	var hist []entry
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		f := strings.Fields(line)
		if len(f) != 2 {
			t.Fatalf("version history line %q is not \"<version> <digest>\"", line)
		}
		hist = append(hist, entry{f[0], f[1]})
	}
	if len(hist) == 0 {
		t.Fatal("version history is empty")
	}

	var prev [3]int
	seen := map[string]bool{}
	for i, h := range hist {
		v, ok := parseSemver(h.version)
		if !ok {
			t.Fatalf("version history entry %d: %q is not MAJOR.MINOR.PATCH", i+1, h.version)
		}
		if i > 0 && cmpSemver(v, prev) <= 0 {
			t.Errorf("version history entry %d: %s does not follow %s; versions must strictly increase", i+1, h.version, hist[i-1].version)
		}
		if seen[h.digest] {
			t.Errorf("version history entry %d: digest %s is recorded twice", i+1, h.digest)
		}
		seen[h.digest] = true
		prev = v
	}

	last := hist[len(hist)-1]
	if last.version != Version || last.digest != digest {
		t.Fatalf("the engine goldens (digest %s) do not match the newest recorded engine version %s (digest %s). "+
			"If the output changed, raise Version above %s and append \"<new Version> %s\" to testdata/version_history.golden; "+
			"if it did not, the golden is wrong",
			digest, last.version, last.digest, last.version, digest)
	}
	if cmpSemver(cur, prev) != 0 {
		t.Fatalf("Version %s is not the last history entry %s", Version, hist[len(hist)-1].version)
	}
}
