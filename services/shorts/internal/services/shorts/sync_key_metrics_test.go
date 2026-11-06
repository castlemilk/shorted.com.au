package shorts

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// TestSyncKeyMetricsIsRetired pins the retired RPC: FailedPrecondition with the
// message the scheduler and operators are pointed at, and nothing else. The
// server has no store or logger here, so any database or Python access would
// panic, which is the point of the test.
func TestSyncKeyMetricsIsRetired(t *testing.T) {
	s := &ShortsServer{}
	for _, req := range []*shortsv1alpha1.SyncKeyMetricsRequest{
		{},
		{StockCodes: []string{"BHP"}, Force: true},
	} {
		resp, err := s.SyncKeyMetrics(context.Background(), connect.NewRequest(req))
		if resp != nil {
			t.Fatalf("response = %v, want none", resp.Msg)
		}
		if err == nil {
			t.Fatal("err = nil, want FailedPrecondition")
		}
		if got := connect.CodeOf(err); got != connect.CodeFailedPrecondition {
			t.Fatalf("code = %v, want FailedPrecondition", got)
		}
		if err.Error() != "failed_precondition: "+keyMetricsRetiredMessage {
			t.Fatalf("message = %q", err.Error())
		}
	}
}
