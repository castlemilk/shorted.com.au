package main

import (
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// operatorIngestModes are the -mode values whose run* function performs an
// ingest and must propagate failure as a non-zero exit code.
//
// Every one of these used to log its error and return normally, so the process
// exited 0 and Cloud Run, launchd and every downstream alert read a failed run
// as healthy. That is how -mode census ran its entire life without ever
// succeeding in a container: censusGeoDir() resolves to a repo-relative path
// absent from the image, readSuburbRegistry failed on every run, and nothing
// said so. See docs/feature/housing/handover-2026-08-27.md.
//
// "seifa" is deliberately absent: it already had its own `return 1` before this
// change and keeps it, so its case does not route through ingestExit.
var operatorIngestModes = []string{
	"census",
	"electorates",
	"banners",
	"amenities",
	"elevation",
	"lga",
	"connectivity",
	"funding",
	"council-financials",
	"crime",
	"backfill-address",
}

// Deliberately NOT in the list above:
//
//   - "seifa" and "vg-nsw"/"vg-vic" already propagate failure through their own
//     `return 1`, so they never route through ingestExit;
//   - "purge" bails out early by design when no BrandBrain credentials are
//     configured ("nothing to do"), which is a legitimate no-op rather than a
//     failure, and its only other exit is an operator-interactive dry run;
//   - "mcp" is a long-lived server, not an ingest.

func TestIngestExit(t *testing.T) {
	t.Parallel()

	if got := ingestExit(nil); got != 0 {
		t.Fatalf("ingestExit(nil) = %d, want 0", got)
	}
	if got := ingestExit(errors.New("read ../web/public/geo/suburbs/NSW.topojson: no such file or directory")); got != 1 {
		t.Fatalf("ingestExit(error) = %d, want 1", got)
	}
}

// TestOperatorIngestModesPropagateFailure reads main.go and asserts that each
// operator-ingest mode's switch case returns through ingestExit.
//
// This is a source-level assertion on purpose. The failure it guards against is
// invisible at runtime — a mode that drops its error still logs, still records
// "error" in sync_status, and still exits 0. Only the shape of the dispatch
// tells you whether the exit code carries the failure, so that is what is
// pinned. A future mode added to this list without the ingestExit wrapper fails
// here rather than in production six months later.
func TestOperatorIngestModesPropagateFailure(t *testing.T) {
	t.Parallel()

	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "main.go", nil, 0)
	if err != nil {
		t.Fatalf("parse main.go: %v", err)
	}

	// Scope the walk to run()'s `switch *mode` specifically. Other switches in
	// this file also key on mode strings — collectorTimeoutMinutes has a
	// `case "agent", "listings", ..., "crime", "drop-index":` — and walking the
	// whole file lets those clauses shadow the dispatch ones.
	var dispatch *ast.SwitchStmt
	ast.Inspect(file, func(n ast.Node) bool {
		fn, ok := n.(*ast.FuncDecl)
		if !ok || fn.Name.Name != "run" || fn.Recv != nil {
			return true
		}
		ast.Inspect(fn, func(inner ast.Node) bool {
			sw, ok := inner.(*ast.SwitchStmt)
			if !ok {
				return true
			}
			star, ok := sw.Tag.(*ast.StarExpr)
			if !ok {
				return true
			}
			if ident, ok := star.X.(*ast.Ident); ok && ident.Name == "mode" {
				dispatch = sw
				return false
			}
			return true
		})
		return false
	})
	if dispatch == nil {
		t.Fatal("could not find run()'s `switch *mode` dispatch in main.go")
	}

	cases := map[string]ast.Stmt{}
	for _, stmt := range dispatch.Body.List {
		clause, ok := stmt.(*ast.CaseClause)
		if !ok {
			continue
		}
		for _, expr := range clause.List {
			lit, ok := expr.(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				continue
			}
			mode, uerr := strconvUnquote(lit.Value)
			if uerr != nil {
				continue
			}
			if len(clause.Body) > 0 {
				cases[mode] = clause.Body[len(clause.Body)-1]
			}
		}
	}

	for _, mode := range operatorIngestModes {
		last, ok := cases[mode]
		if !ok {
			t.Errorf("-mode %q has no case clause in main.go's dispatch switch", mode)
			continue
		}
		ret, ok := last.(*ast.ReturnStmt)
		if !ok || len(ret.Results) != 1 {
			t.Errorf("-mode %q does not end in a single-value return; a dropped error exits 0 and reports a failed ingest as healthy", mode)
			continue
		}
		call, ok := ret.Results[0].(*ast.CallExpr)
		if !ok {
			t.Errorf("-mode %q does not return a call expression; want return ingestExit(run...(ctx, pool))", mode)
			continue
		}
		ident, ok := call.Fun.(*ast.Ident)
		if !ok || ident.Name != "ingestExit" {
			t.Errorf("-mode %q returns something other than ingestExit(...); its ingest failure would not reach the exit code", mode)
		}
	}
}

func strconvUnquote(s string) (string, error) {
	if len(s) < 2 || s[0] != '"' || s[len(s)-1] != '"' {
		return "", errors.New("not a quoted string")
	}
	return s[1 : len(s)-1], nil
}
