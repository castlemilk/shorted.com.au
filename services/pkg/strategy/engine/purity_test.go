package engine

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// TestNoClockNoIONoRand holds the evaluator to the purity rule of
// architecture 4.1: a function of its inputs only. Every non-test file in this
// package may import the standard library and nothing else, and may not read
// the clock, draw random numbers or read the environment. The check parses the
// source rather than trusting review, so a new call fails the build.
func TestNoClockNoIONoRand(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	checked := 0
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		checked++
		file, err := parser.ParseFile(fset, name, nil, parser.ParseComments)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		for _, v := range purityViolations(file) {
			t.Errorf("%s: %s", name, v)
		}
	}
	if checked == 0 {
		t.Fatal("no source files found; the scan would pass vacuously")
	}
}

// forbiddenCalls maps an import path to the selectors that break purity.
// A nil set forbids every selector of the package.
var forbiddenCalls = map[string]map[string]bool{
	"time":         {"Now": true, "Since": true, "Until": true},
	"math/rand":    nil,
	"math/rand/v2": nil,
	"crypto/rand":  nil,
	"os":           {"Getenv": true, "LookupEnv": true, "Environ": true},
}

// purityViolations returns one message per import or call that breaks the rule.
func purityViolations(file *ast.File) []string {
	var out []string
	names := map[string]string{} // local name -> import path
	for _, imp := range file.Imports {
		path, err := strconv.Unquote(imp.Path.Value)
		if err != nil {
			out = append(out, "unreadable import "+imp.Path.Value)
			continue
		}
		if first := strings.SplitN(path, "/", 2)[0]; strings.Contains(first, ".") {
			out = append(out, "non-standard-library import "+path)
		}
		if _, banned := forbiddenCalls[path]; banned && imp.Name != nil && imp.Name.Name != "_" {
			names[imp.Name.Name] = path
		} else if banned {
			names[importName(path)] = path
		}
		if imp.Name != nil && imp.Name.Name == "." {
			out = append(out, "dot import of "+path)
		}
	}
	ast.Inspect(file, func(n ast.Node) bool {
		sel, ok := n.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		ident, ok := sel.X.(*ast.Ident)
		if !ok {
			return true
		}
		path, ok := names[ident.Name]
		if !ok {
			return true
		}
		if calls := forbiddenCalls[path]; calls == nil || calls[sel.Sel.Name] {
			out = append(out, "forbidden call "+path+"."+sel.Sel.Name)
		}
		return true
	})
	sort.Strings(out)
	return out
}

// TestPurityScanCatchesViolations keeps the scan honest: it must flag each
// forbidden form on a synthetic file, so a broken scan cannot pass silently.
func TestPurityScanCatchesViolations(t *testing.T) {
	src := `package engine

import (
	"github.com/acme/thing"
	"os"
	t "time"
	r "math/rand"
)

var _ = thing.Get
var _ = os.Getenv("X")
var _ = t.Now()
var _ = r.Intn(3)
`
	file, err := parser.ParseFile(token.NewFileSet(), "synthetic.go", src, 0)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(purityViolations(file), "\n")
	for _, want := range []string{
		"non-standard-library import github.com/acme/thing",
		"forbidden call os.Getenv",
		"forbidden call time.Now",
		"forbidden call math/rand.Intn",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("scan missed %q; got:\n%s", want, got)
		}
	}
}

// importName is the package name a path imports under: its last element, or
// the one before a major-version suffix such as math/rand/v2.
func importName(path string) string {
	parts := strings.Split(path, "/")
	last := parts[len(parts)-1]
	if len(parts) > 1 && len(last) > 1 && last[0] == 'v' && strings.Trim(last[1:], "0123456789") == "" {
		return parts[len(parts)-2]
	}
	return last
}
