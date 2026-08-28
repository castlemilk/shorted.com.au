package oauth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMetadataDescribesThisDeployment(t *testing.T) {
	md := Metadata(Endpoints{APIBaseURL: "https://api.example.test", ConsentURL: "https://example.test/oauth/authorize"})

	if md.Issuer != "https://api.example.test" {
		t.Errorf("Issuer = %q", md.Issuer)
	}
	if md.AuthorizationEndpoint != "https://example.test/oauth/authorize" {
		t.Errorf("AuthorizationEndpoint = %q", md.AuthorizationEndpoint)
	}
	if md.TokenEndpoint != "https://api.example.test/oauth/token" {
		t.Errorf("TokenEndpoint = %q", md.TokenEndpoint)
	}
	if md.RegistrationEndpoint != "https://api.example.test/oauth/register" {
		t.Errorf("RegistrationEndpoint = %q", md.RegistrationEndpoint)
	}
	if !md.AuthorizationResponseIssParameterSupported {
		t.Error("authorization_response_iss_parameter_supported must be true: the grant returns iss (RFC 9207)")
	}
	if len(md.CodeChallengeMethodsSupported) != 1 || md.CodeChallengeMethodsSupported[0] != "S256" {
		t.Errorf("CodeChallengeMethodsSupported = %v, want [S256] only", md.CodeChallengeMethodsSupported)
	}
	if len(md.ResponseTypesSupported) != 1 || md.ResponseTypesSupported[0] != "code" {
		t.Errorf("ResponseTypesSupported = %v, want [code]", md.ResponseTypesSupported)
	}
	wantGrants := map[string]bool{"authorization_code": true, "refresh_token": true}
	if len(md.GrantTypesSupported) != 2 {
		t.Fatalf("GrantTypesSupported = %v", md.GrantTypesSupported)
	}
	for _, g := range md.GrantTypesSupported {
		if !wantGrants[g] {
			t.Errorf("unexpected grant type %q", g)
		}
	}
}

// A dev deployment must advertise ITSELF. Hardcoding prod here would send a dev
// client to prod's token endpoint with a dev-issued code.
func TestMetadataDefaultsToTheDeploymentOrigin(t *testing.T) {
	md := Metadata(Endpoints{})
	if md.Issuer != DefaultAPIBaseURL {
		t.Errorf("Issuer = %q, want %q", md.Issuer, DefaultAPIBaseURL)
	}
	if md.AuthorizationEndpoint != DefaultConsentURL {
		t.Errorf("AuthorizationEndpoint = %q, want %q", md.AuthorizationEndpoint, DefaultConsentURL)
	}
}

func TestMetadataHandlerServesJSONWithoutAnEmptyJWKSURI(t *testing.T) {
	rec := httptest.NewRecorder()
	MetadataHandler(Endpoints{}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, AuthorizationServerMetadataPath, nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q", got)
	}
	// Browser-based clients discover this cross-origin.
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, want *", got)
	}

	var doc map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("body is not JSON: %v (%s)", err, rec.Body.String())
	}
	// Tokens are HS256 and symmetric: there is no key set to publish. An empty
	// string would send a client fetching "" and failing discovery.
	if _, ok := doc["jwks_uri"]; ok {
		t.Errorf("jwks_uri must be absent, got %v", doc["jwks_uri"])
	}
	if doc["authorization_response_iss_parameter_supported"] != true {
		t.Errorf("authorization_response_iss_parameter_supported = %v", doc["authorization_response_iss_parameter_supported"])
	}
	if _, ok := doc["scopes_supported"]; !ok {
		t.Error("scopes_supported missing")
	}
}
