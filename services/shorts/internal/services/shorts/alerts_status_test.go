package shorts

import (
	"testing"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/alertevents"
)

// An event waiting on its owner's entitlement lookup is queued, not failed, so it
// reads as Pending to the customer.
func TestAwaitingEntitlementReadsAsPending(t *testing.T) {
	cases := map[string]shortsv1alpha1.AlertDeliveryStatus{
		alertevents.StatusAwaitingEntitlement: shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_PENDING,
		alertevents.StatusPending:             shortsv1alpha1.AlertDeliveryStatus_ALERT_DELIVERY_STATUS_PENDING,
	}
	for status, want := range cases {
		if got := alertDeliveryStatusFromStore(status); got != want {
			t.Fatalf("alertDeliveryStatusFromStore(%q) = %v, want %v", status, got, want)
		}
	}
}
