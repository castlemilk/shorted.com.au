package shorts

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

func readRepoFile(t *testing.T, path string) string {
	t.Helper()
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(contents)
}

func TestSuburbColumnarRPCsArePublicOnDomainAndLegacyServices(t *testing.T) {
	housing := readRepoFile(t, "../../../../../proto/shortedapi/shorts/v1alpha1/housing.proto")
	legacy := readRepoFile(t, "../../../../../proto/shortedapi/shorts/v1alpha1/shorts.proto")
	for _, rpc := range []string{"GetSuburbIndex", "GetSuburbMetricColumns", "FilterSuburbs"} {
		pattern := regexp.MustCompile(`(?s)rpc\s+` + rpc + `\s*\([^)]*\)\s*returns\s*\([^)]*\)\s*\{.*?visibility\)\s*=\s*VISIBILITY_PUBLIC\s*;.*?\}`)
		if !pattern.MatchString(housing) {
			t.Errorf("HousingService %s is missing or not public", rpc)
		}
		if !pattern.MatchString(legacy) {
			t.Errorf("ShortedStocksService %s is missing or not public", rpc)
		}
	}
}

func TestSuburbColumnarProtoDocumentsPackedValuesAndMaskConventions(t *testing.T) {
	housing := readRepoFile(t, "../../../../../proto/shortedapi/shorts/v1alpha1/housing.proto")
	for _, want := range []string{
		"repeated float values",
		"bytes null_mask",
		"bytes match_mask",
		"optional float min",
		"optional float max",
		"Least-significant-bit first",
		"1 means NULL",
		"1 means the suburb matches",
		"packed by default in proto3",
		"string index_version",
	} {
		if !strings.Contains(housing, want) {
			t.Errorf("housing.proto missing %q", want)
		}
	}
	if strings.Contains(housing, "packed = false") {
		t.Fatal("metric values must retain proto3 packed encoding")
	}
}
