package shorts

import (
	"fmt"
	"testing"
)

// The coverage caveat on a compare page is a claim about a NAMED person: "we
// have not finished reading the 47th, and they sat in it". Narrowing the corpus
// buckets with the member's politician_terms rows made that claim answer the
// wrong question, because a term row exists only where their document already
// EXTRACTED. These cases pin the span to first_parliament..last_parliament,
// which does not move when an extraction fails.
func TestParliamentRangeIsContiguousAndExtractionIndependent(t *testing.T) {
	corpusExtracted := []int32{44, 45}
	corpusPartial := []int32{46, 47}
	corpusPending := []int32{48}

	for _, tc := range []struct {
		name                        string
		first, last                 int32
		extracted, partial, pending []int32
	}{
		{
			// The bug in one line: 48 is PENDING, so nobody has a term in it (a
			// pending parliament has no extracted documents at all), so the old
			// terms-derived span dropped it for every member alive. This member
			// sat in the 48th and must be told we have not read it.
			name:  "a 44-48 member keeps the pending 48th",
			first: 44, last: 48,
			extracted: []int32{44, 45}, partial: []int32{46, 47}, pending: []int32{48},
		},
		{
			// The other half: a member elected at the 48th is not implicated by
			// the 46th's half-finished extraction and must not be shown its
			// caveat.
			name:  "a 48-only member shows no 44-47 bucket",
			first: 48, last: 48,
			extracted: nil, partial: nil, pending: []int32{48},
		},
		{
			// Interior parliaments count even though no term row proves them:
			// Dan Tehan's terms are {44,45,48} precisely BECAUSE the 46th and
			// 47th failed to extract, which is the case the caveat exists for.
			name:  "a mid-span member keeps the partial parliaments their terms lack",
			first: 45, last: 47,
			extracted: []int32{45}, partial: []int32{46, 47}, pending: nil,
		},
		{
			name:  "a single retired parliament narrows to itself",
			first: 44, last: 44,
			extracted: []int32{44}, partial: nil, pending: nil,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			span := parliamentRange(tc.first, tc.last)
			if span == nil {
				t.Fatalf("parliamentRange(%d, %d) = nil, want a known span", tc.first, tc.last)
			}
			assertParliaments(t, "extracted", intersectParliaments(corpusExtracted, span), tc.extracted)
			assertParliaments(t, "partial", intersectParliaments(corpusPartial, span), tc.partial)
			assertParliaments(t, "pending", intersectParliaments(corpusPending, span), tc.pending)
		})
	}
}

// An unknown span keeps the corpus buckets WHOLE. A superset over-warns, which
// is survivable; an invented subset states we read a parliament for a named
// person when we did not.
func TestUnknownParliamentSpanKeepsTheCorpusBucketsWhole(t *testing.T) {
	corpus := []int32{44, 45, 46}
	for _, tc := range []struct{ first, last int32 }{
		{0, 0},   // never populated
		{0, 48},  // only an end
		{44, 0},  // only a start
		{48, 44}, // inverted
	} {
		if span := parliamentRange(tc.first, tc.last); span != nil {
			t.Fatalf("parliamentRange(%d, %d) = %v, want nil for an unknown span", tc.first, tc.last, span)
		}
		assertParliaments(t, fmt.Sprintf("span(%d,%d)", tc.first, tc.last),
			intersectParliaments(corpus, parliamentRange(tc.first, tc.last)), corpus)
	}
}

func assertParliaments(t *testing.T, bucket string, got, want []int32) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s = %v, want %v", bucket, got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%s = %v, want %v", bucket, got, want)
		}
	}
}
