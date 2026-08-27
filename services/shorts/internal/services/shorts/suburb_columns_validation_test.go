package shorts

import (
	"testing"

	"connectrpc.com/connect"

	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

func TestValidateSuburbMetricKeysRejectsUnknownAsInvalidArgument(t *testing.T) {
	_, err := validateSuburbMetricKeys([]string{"population", "not_a_metric"})
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("unknown key code = %v, want InvalidArgument (err=%v)", connect.CodeOf(err), err)
	}
}

func TestValidateSuburbMetricKeysAcceptsKnownKeys(t *testing.T) {
	got, err := validateSuburbMetricKeys([]string{"population", "seifa_irsd_score"})
	if err != nil {
		t.Fatalf("known keys rejected: %v", err)
	}
	if len(got) != 2 || got[0] != "population" || got[1] != "seifa_irsd_score" {
		t.Fatalf("validated keys = %v", got)
	}
}

func TestValidateSuburbMetricKeysRequiresAtLeastOneKey(t *testing.T) {
	_, err := validateSuburbMetricKeys(nil)
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("empty key list code = %v, want InvalidArgument", connect.CodeOf(err))
	}
}

func TestValidateSuburbPredicatesMapsValidationToInvalidArgument(t *testing.T) {
	min := float32(0)
	for _, predicates := range [][]shortsstore.SuburbMetricPredicateRow{
		nil,
		{{MetricKey: "not_a_metric", Min: &min}},
		{{MetricKey: "population"}},
	} {
		if err := validateSuburbPredicates(predicates); connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Fatalf("predicates %+v code = %v, want InvalidArgument (err=%v)", predicates, connect.CodeOf(err), err)
		}
	}
}
