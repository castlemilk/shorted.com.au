package shorts

import (
	"encoding/json"
	"errors"

	"connectrpc.com/connect"
)

// entitlementDetailHeader carries the machine-readable reason a call was
// refused on entitlement. Clients read it from the error metadata, the way
// they read X-RateLimit-Detail.
const entitlementDetailHeader = "X-Entitlement-Detail"

// capabilityFullSignalList names the refusal for an offset into a public
// picks list whose depth is clamped.
const capabilityFullSignalList = "full_signal_list"

// EntitlementDetail is the compact JSON in X-Entitlement-Detail. Field names
// are a wire contract for clients, so renaming one is a breaking change.
type EntitlementDetail struct {
	Capability string `json:"capability"`
	Required   string `json:"required"`
	Current    string `json:"current,omitempty"`
	RPC        string `json:"rpc,omitempty"`
	Limit      int    `json:"limit,omitempty"`
	UpgradeURL string `json:"upgrade_url"`
	Message    string `json:"message"`
}

// newEntitlementError is a connect error whose metadata carries detail.
func newEntitlementError(code connect.Code, detail EntitlementDetail) error {
	body, err := json.Marshal(detail)
	if err != nil {
		return connect.NewError(code, errors.New(detail.Message))
	}
	connectErr := connect.NewError(code, errors.New(detail.Message))
	connectErr.Meta().Set(entitlementDetailHeader, string(body))
	return connectErr
}

// fullSignalListRefused is the refusal for an offset into a clamped public
// picks list. It names the private rpc that serves the full list, so a client
// can switch to it with its bearer token.
func fullSignalListRefused(current Access, clampLimit int) error {
	return newEntitlementError(connect.CodePermissionDenied, EntitlementDetail{
		Capability: capabilityFullSignalList,
		Required:   AccessFree.String(),
		Current:    current.String(),
		RPC:        "GetViewerStrategyPicks",
		Limit:      clampLimit,
		UpgradeURL: defaultUpgradeURL,
		Message:    "The public list is the top picks only. Signed-in callers get the full list from GetViewerStrategyPicks.",
	})
}
