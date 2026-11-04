package engine

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// TestNoClockNoIONoRand holds the strategy packages to a purity rule: an output
// is a function of the inputs alone. Every non-test file under
// services/pkg/strategy (pgsource excepted, the one package that does I/O) may
// import only the standard-library packages in pureImports, and may not read the
// clock, sleep, wait on a timer, load a time zone, print, or draw random
// numbers. The check parses the source rather than trusting review, so a new
// import or call fails the build.
func TestNoClockNoIONoRand(t *testing.T) {
	root := ".." // services/pkg/strategy: the parent of this engine package
	fset := token.NewFileSet()
	scanned := map[string]bool{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "pgsource" {
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		scanned[filepath.Base(filepath.Dir(path))] = true
		file, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		for _, v := range purityViolations(file) {
			t.Errorf("%s: %s", path, v)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// The scan must reach both packages, or it would pass vacuously.
	for _, dir := range []string{"engine", "instrument"} {
		if !scanned[dir] {
			t.Fatalf("no source files scanned under package %q; the scan would pass vacuously", dir)
		}
	}
}

// pureImports is the allowlist: the standard-library packages a strategy package
// may import. Everything else, including os, io, net/..., os/exec, database/sql,
// syscall, log, math/rand and crypto/rand, is a violation. The encoding and hash
// packages are here because the spec package names a version by the hash of its
// canonical JSON: they read and write memory only.
var pureImports = map[string]bool{
	"cmp":           true,
	"crypto/sha256": true,
	"encoding/hex":  true,
	"encoding/json": true,
	"errors":        true,
	"fmt":           true,
	"maps":          true,
	"math":          true,
	"math/bits":     true,
	"reflect":       true,
	"regexp":        true,
	"slices":        true,
	"sort":          true,
	"strconv":       true,
	"strings":       true,
	"time":          true,
	"unicode":       true,
	"unicode/utf8":  true,
}

// pureModuleImport reports whether a non-standard-library import is allowed: the
// civil date value type, the ASX holiday table (a pure time-only package), and
// the strategy packages themselves (which are held to this same rule). pgsource
// is the one package that does I/O and is never imported by a pure package.
func pureModuleImport(path string) bool {
	switch path {
	case "cloud.google.com/go/civil",
		"github.com/castlemilk/shorted.com.au/services/pkg/asxcalendar":
		return true
	}
	const tree = "github.com/castlemilk/shorted.com.au/services/pkg/strategy/"
	return strings.HasPrefix(path, tree) && !strings.HasPrefix(path, tree+"pgsource")
}

// forbiddenSelectors lists the selectors of an allowed package that break
// purity: clock reads, timers and sleeps, time-zone loading and ambient
// time.Local, and printing or scanning to or from the process's streams.
var forbiddenSelectors = map[string]map[string]bool{
	"time": {
		"Now": true, "Since": true, "Until": true, "Sleep": true, "After": true,
		"AfterFunc": true, "Tick": true, "NewTicker": true, "NewTimer": true,
		"LoadLocation": true, "Local": true,
	},
	"fmt": {
		"Print": true, "Println": true, "Printf": true,
		"Fprint": true, "Fprintln": true, "Fprintf": true,
		"Scan": true, "Scanln": true, "Scanf": true,
		"Fscan": true, "Fscanln": true, "Fscanf": true,
	},
}

// purityViolations returns one message per import or call that breaks the rule.
func purityViolations(file *ast.File) []string {
	var out []string
	names := map[string]string{} // local name -> import path, for packages with forbidden selectors
	for _, imp := range file.Imports {
		path, err := strconv.Unquote(imp.Path.Value)
		if err != nil {
			out = append(out, "unreadable import "+imp.Path.Value)
			continue
		}
		if pureModuleImport(path) {
			// A pure value package or another package of this tree.
		} else if first := strings.SplitN(path, "/", 2)[0]; strings.Contains(first, ".") {
			out = append(out, "non-standard-library import "+path)
		} else if !pureImports[path] {
			out = append(out, "import "+path+" is outside the pure standard-library allowlist")
		}
		if imp.Name != nil && imp.Name.Name == "." {
			out = append(out, "dot import of "+path)
		}
		if _, guarded := forbiddenSelectors[path]; guarded && (imp.Name == nil || imp.Name.Name != "_") {
			local := importName(path)
			if imp.Name != nil {
				local = imp.Name.Name
			}
			names[local] = path
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
		if forbiddenSelectors[path][sel.Sel.Name] {
			out = append(out, "forbidden call "+path+"."+sel.Sel.Name)
		}
		return true
	})
	sort.Strings(out)
	return out
}

// TestPurityScanCatchesViolations keeps the scan honest: each forbidden form
// must be flagged on a synthetic file, and an ordinary pure file must pass, so
// a broken scan cannot pass silently.
func TestPurityScanCatchesViolations(t *testing.T) {
	cases := []struct {
		name string
		src  string
		want []string // substrings that must each appear in the violations
	}{
		{
			name: "non-standard-library import",
			src:  "package engine\n\nimport \"github.com/acme/thing\"\n\nvar _ = thing.Get\n",
			want: []string{"non-standard-library import github.com/acme/thing"},
		},
		{
			name: "os reads the environment and files",
			src:  "package engine\n\nimport \"os\"\n\nvar _ = os.Getenv(\"X\")\nvar _, _ = os.ReadFile(\"f\")\nvar _ = os.ExpandEnv(\"$HOME\")\n",
			want: []string{"import os is outside"},
		},
		{
			name: "syscall reads the environment",
			src:  "package engine\n\nimport \"syscall\"\n\nvar _, _ = syscall.Getenv(\"HOME\")\n",
			want: []string{"import syscall is outside"},
		},
		{
			name: "network and process packages",
			src:  "package engine\n\nimport (\n\t\"net/http\"\n\t\"os/exec\"\n)\n\nvar _, _ = http.Get(\"u\")\nvar _ = exec.Command(\"ls\")\n",
			want: []string{"import net/http is outside", "import os/exec is outside"},
		},
		{
			name: "aliased time reads the clock",
			src:  "package engine\n\nimport t \"time\"\n\nvar _ = t.Now()\n",
			want: []string{"forbidden call time.Now"},
		},
		{
			name: "time timers, sleeps and zones",
			src:  "package engine\n\nimport \"time\"\n\nvar _ = time.After(time.Second)\nvar _ = time.Sleep\nvar _ = time.LoadLocation(\"Australia/Sydney\")\nvar _ = time.Local\n",
			want: []string{"forbidden call time.After", "forbidden call time.Sleep", "forbidden call time.LoadLocation", "forbidden call time.Local"},
		},
		{
			name: "math/rand",
			src:  "package engine\n\nimport r \"math/rand\"\n\nvar _ = r.Intn(3)\n",
			want: []string{"import math/rand is outside"},
		},
		{
			name: "printing to the process streams",
			src:  "package engine\n\nimport \"fmt\"\n\nfunc f() { fmt.Println(\"x\") }\n",
			want: []string{"forbidden call fmt.Println"},
		},
		{
			name: "dot import",
			src:  "package engine\n\nimport . \"time\"\n\nvar _ = Duration(1)\n",
			want: []string{"dot import of time"},
		},
		{
			name: "pure file passes",
			src:  "package engine\n\nimport (\n\t\"fmt\"\n\t\"strings\"\n\t\"time\"\n)\n\nvar _ = fmt.Sprintf(\"%s\", strings.ToUpper(\"x\"))\nvar _ time.Duration = time.Second\n",
			want: nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			file, err := parser.ParseFile(token.NewFileSet(), "synthetic.go", tc.src, 0)
			if err != nil {
				t.Fatal(err)
			}
			got := purityViolations(file)
			if tc.want == nil {
				if len(got) != 0 {
					t.Fatalf("pure file flagged: %v", got)
				}
				return
			}
			joined := strings.Join(got, "\n")
			for _, want := range tc.want {
				if !strings.Contains(joined, want) {
					t.Errorf("scan missed %q; got:\n%s", want, joined)
				}
			}
		})
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
