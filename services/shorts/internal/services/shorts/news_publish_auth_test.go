package shorts

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// recordActor is a handler that records whether it ran and the actor it saw.
func recordActor(ran *bool, actor *string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		*ran = true
		*actor = r.Header.Get("x-admin-actor")
		w.WriteHeader(http.StatusAccepted)
	}
}

func TestNewsPublishAuth(t *testing.T) {
	cases := []struct {
		name     string
		token    string // NEWS_PUBLISH_TOKEN
		internal string // INTERNAL_SERVICE_SECRET
		headers  map[string]string
		wantRun  bool
		wantCode int
		actor    string
	}{
		{"scoped token header", "tok", "admin", map[string]string{"x-news-publish-token": "tok"}, true, 202, "news-publish-token"},
		{"scoped token bearer", "tok", "admin", map[string]string{"Authorization": "Bearer tok"}, true, 202, "news-publish-token"},
		{"scoped token cannot pick its actor", "tok", "admin",
			map[string]string{"x-news-publish-token": "tok", "x-admin-actor": "someone@else"}, true, 202, "news-publish-token"},
		{"internal secret still works", "tok", "admin",
			map[string]string{"x-internal-secret": "admin", "x-admin-actor": "ben@shorted.com.au"}, true, 202, "ben@shorted.com.au"},
		{"wrong scoped token", "tok", "admin", map[string]string{"x-news-publish-token": "nope"}, false, 401, ""},
		{"no credential", "tok", "admin", nil, false, 401, ""},
		{"unset token never matches empty", "", "admin", map[string]string{"x-news-publish-token": ""}, false, 401, ""},
		{"unset token rejects any value", "", "admin", map[string]string{"x-news-publish-token": "tok"}, false, 401, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("NEWS_PUBLISH_TOKEN", tc.token)
			t.Setenv("INTERNAL_SERVICE_SECRET", tc.internal)
			var ran bool
			var actor string
			h := newsPublishAuthMiddleware(recordActor(&ran, &actor))
			r := httptest.NewRequest(http.MethodPost, "/api/admin/news/publish", nil)
			for k, v := range tc.headers {
				r.Header.Set(k, v)
			}
			w := httptest.NewRecorder()
			h(w, r)
			if ran != tc.wantRun || w.Code != tc.wantCode {
				t.Fatalf("ran=%v code=%d, want ran=%v code=%d", ran, w.Code, tc.wantRun, tc.wantCode)
			}
			if tc.wantRun && actor != tc.actor {
				t.Fatalf("actor = %q, want %q", actor, tc.actor)
			}
		})
	}
}

// The scoped token must not open any other admin route: they keep using
// adminAuthMiddleware, which has never heard of it.
func TestNewsPublishTokenDoesNotOpenOtherAdminRoutes(t *testing.T) {
	t.Setenv("NEWS_PUBLISH_TOKEN", "tok")
	t.Setenv("INTERNAL_SERVICE_SECRET", "admin")
	var ran bool
	var actor string
	h := adminAuthMiddleware(recordActor(&ran, &actor))
	r := httptest.NewRequest(http.MethodPost, "/api/admin/jobs/run", nil)
	r.Header.Set("x-news-publish-token", "tok")
	r.Header.Set("Authorization", "Bearer tok")
	w := httptest.NewRecorder()
	h(w, r)
	if ran || w.Code != http.StatusUnauthorized {
		t.Fatalf("scoped token opened /api/admin/jobs/run: ran=%v code=%d", ran, w.Code)
	}
}
