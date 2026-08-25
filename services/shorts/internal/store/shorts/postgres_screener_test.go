package shorts

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

func TestNormalizeScreenerProductCodes(t *testing.T) {
	tests := []struct {
		name  string
		codes []string
		want  []string
	}{
		{name: "nil is no filter", codes: nil, want: nil},
		{name: "empty is no filter", codes: []string{}, want: nil},
		{name: "whitespace-only entries are no filter", codes: []string{"", "  "}, want: nil},
		{name: "uppercases and trims", codes: []string{" pls ", "min"}, want: []string{"PLS", "MIN"}},
		{name: "de-duplicates case-insensitively", codes: []string{"PLS", "pls", "LTR"}, want: []string{"PLS", "LTR"}},
		{name: "preserves order", codes: []string{"LYC", "ILU", "ARU"}, want: []string{"LYC", "ILU", "ARU"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, NormalizeScreenerProductCodes(tt.codes))
		})
	}
}

func TestBuildScreenerConditions_ProductCodes(t *testing.T) {
	conditions, args := buildScreenerConditions(&shortsv1alpha1.ScreenerFilters{
		ProductCodes: []string{" pls ", "min", "PLS"},
	})

	require.Len(t, conditions, 1)
	assert.Equal(t, "stock_code = ANY($1)", conditions[0])
	require.Len(t, args, 1)
	assert.Equal(t, []string{"PLS", "MIN"}, args[0])
}

func TestBuildScreenerConditions_EmptyProductCodesLeavesQueryUnchanged(t *testing.T) {
	for _, codes := range [][]string{nil, {}, {" ", ""}} {
		conditions, args := buildScreenerConditions(&shortsv1alpha1.ScreenerFilters{ProductCodes: codes})
		assert.Empty(t, conditions, "empty product_codes must not add a condition")
		assert.Empty(t, args)
	}
}

func TestBuildScreenerConditions_ProductCodesCapped(t *testing.T) {
	codes := make([]string, 0, MaxScreenerProductCodes+50)
	for i := 0; i < cap(codes); i++ {
		codes = append(codes, screenerTestCode(i))
	}

	conditions, args := buildScreenerConditions(&shortsv1alpha1.ScreenerFilters{ProductCodes: codes})

	require.Len(t, conditions, 1)
	require.Len(t, args, 1)
	assert.Len(t, args[0], MaxScreenerProductCodes)
}

// Placeholders must stay contiguous so LIMIT/OFFSET, numbered from
// len(args)+1 by the caller, line up with the bind args.
func TestBuildScreenerConditions_PlaceholdersAreContiguous(t *testing.T) {
	conditions, args := buildScreenerConditions(&shortsv1alpha1.ScreenerFilters{
		ShortPct:        &shortsv1alpha1.RangeFilter{Min: 5, HasMin: true},
		Industries:      []string{"Materials"},
		ProductCodes:    []string{"PLS"},
		HasDirectorBuys: true,
	})

	joined := strings.Join(conditions, " AND ")
	assert.Contains(t, joined, "short_pct >= $1")
	assert.Contains(t, joined, "industry = ANY($2)")
	assert.Contains(t, joined, "stock_code = ANY($3)")
	assert.Contains(t, joined, "director_buy_count > 0")
	assert.Len(t, args, 3)
}

func TestBuildScreenerConditions_NilFilters(t *testing.T) {
	conditions, args := buildScreenerConditions(nil)
	assert.Empty(t, conditions)
	assert.Empty(t, args)
}

// screenerTestCode produces distinct 3-character codes (AAA, AAB, ...).
func screenerTestCode(i int) string {
	const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	return string([]byte{'A', letters[(i/26)%26], letters[i%26]})
}
