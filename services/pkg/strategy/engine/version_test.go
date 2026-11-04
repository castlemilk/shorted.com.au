package engine

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"testing"
)

// specGoldenPath is the golden file of registered rules hashes. A change to it
// is a change to what the engine means by a version.
const specGoldenPath = "../spec/testdata/spec_hashes.golden"

// TestEngineVersionBumpedWithGoldens holds Version to the spec goldens. The
// history file records, for each engine version, the digest of the spec goldens
// it shipped with. The newest line must be the current Version with the current
// digest, so changing a golden without bumping Version (or without recording the
// bump) fails.
func TestEngineVersionBumpedWithGoldens(t *testing.T) {
	if !strings.HasPrefix(Version, fmt.Sprintf("%d.", Major)) {
		t.Fatalf("Version %q does not carry Major %d", Version, Major)
	}
	golden, err := os.ReadFile(specGoldenPath)
	if err != nil {
		t.Fatalf("read spec goldens: %v", err)
	}
	sum := sha256.Sum256(golden)
	digest := hex.EncodeToString(sum[:])

	f, err := os.Open("testdata/version_history.golden")
	if err != nil {
		t.Fatalf("open version history: %v", err)
	}
	defer f.Close()
	var last []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		last = strings.Fields(line)
	}
	if err := sc.Err(); err != nil {
		t.Fatalf("read version history: %v", err)
	}
	if len(last) != 2 {
		t.Fatalf("version history has no line of the form \"<version> <digest>\"")
	}
	if last[0] != Version || last[1] != digest {
		t.Fatalf("the spec goldens (digest %s) do not match the newest recorded engine version %s (digest %s): "+
			"a golden changed, so bump Version and append \"%s %s\" to testdata/version_history.golden",
			digest, last[0], last[1], Version, digest)
	}
}
