package main

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// TestWeeklyReportWithoutWeekSendsLatestSlug covers get_weekly_report with no week:
// the API requires a week_slug, so the newest weekly slug is looked up first and
// then fetched. The model's "latest" must not reach the API as an empty slug.
func TestWeeklyReportWithoutWeekSendsLatestSlug(t *testing.T) {
	var paths []string
	executor := newTestToolExecutor(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read body: %v", err)
			return
		}
		switch r.URL.Path {
		case "/shorts.v1alpha1." + legacyShortsService + "/ListReports":
			var request shortsv1alpha1.ListReportsRequest
			if err := (protojson.UnmarshalOptions{}).Unmarshal(body, &request); err != nil {
				t.Errorf("ListReports body %s does not unmarshal strictly: %v", body, err)
			}
			if request.GetReportType() != "weekly" || request.GetLimit() != 1 {
				t.Errorf("ListReports = type %q limit %d, want weekly limit 1", request.GetReportType(), request.GetLimit())
			}
			_, _ = w.Write([]byte(`{"reports":[{"slug":"2026-W42","reportType":"weekly"},{"slug":"2026-W41","reportType":"weekly"}]}`))
		case "/shorts.v1alpha1." + legacyShortsService + "/GetWeeklyReport":
			var request shortsv1alpha1.GetWeeklyReportRequest
			if err := (protojson.UnmarshalOptions{}).Unmarshal(body, &request); err != nil {
				t.Errorf("GetWeeklyReport body %s does not unmarshal strictly: %v", body, err)
			}
			if got := request.GetWeekSlug(); got != "2026-W42" {
				t.Errorf("week_slug = %q, want the latest slug 2026-W42 (body %s)", got, body)
			}
			_, _ = w.Write([]byte(`{"weekSlug":"2026-W42","headline":"latest"}`))
		default:
			t.Errorf("unexpected call to %s", r.URL.Path)
		}
	}))

	result, err := executor.Execute(context.Background(), "get_weekly_report", map[string]any{})
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if want := []string{"/shorts.v1alpha1." + legacyShortsService + "/ListReports", "/shorts.v1alpha1." + legacyShortsService + "/GetWeeklyReport"}; strings.Join(paths, " ") != strings.Join(want, " ") {
		t.Fatalf("calls = %v, want %v", paths, want)
	}
	if !strings.Contains(result, `"weekSlug":"2026-W42"`) {
		t.Errorf("result = %s, want the 2026-W42 report", result)
	}
}

// TestWeeklyReportWithoutWeekFailsWhenNoReportIsPublished checks that an empty
// archive is an error for the model and does not reach GetWeeklyReport with an
// empty slug.
func TestWeeklyReportWithoutWeekFailsWhenNoReportIsPublished(t *testing.T) {
	var paths []string
	executor := newTestToolExecutor(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		_, _ = w.Write([]byte(`{"reports":[]}`))
	}))

	_, err := executor.Execute(context.Background(), "get_weekly_report", map[string]any{})
	if err == nil || !strings.Contains(err.Error(), "no published weekly report") {
		t.Fatalf("Execute() error = %v, want no published weekly report", err)
	}
	if len(paths) != 1 || !strings.HasSuffix(paths[0], "/ListReports") {
		t.Fatalf("calls = %v, want only ListReports", paths)
	}
}

// TestLatestReportLookupRPCExists checks the ListReports call against the generated
// descriptors, as the contract test does for the tool calls.
func TestLatestReportLookupRPCExists(t *testing.T) {
	assertRPCTakes(t, legacyShortsService, "ListReports", (&shortsv1alpha1.ListReportsRequest{}).ProtoReflect().Descriptor())
}
