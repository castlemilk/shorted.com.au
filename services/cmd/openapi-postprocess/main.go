// Command openapi-postprocess turns the raw protoc-gen-connect-openapi output
// into the single canonical OpenAPI document the site serves.
//
// Usage:
//
//	openapi-postprocess -in api/schema/generated/openapi.yaml \
//	  -base api/schema/base.yaml \
//	  -out-json web/public/openapi.json -out-yaml web/public/openapi.yaml
package main

import (
	"encoding/json"
	"flag"
	"log"
	"os"

	"sigs.k8s.io/yaml"
)

func main() {
	in := flag.String("in", "", "raw generated OpenAPI YAML")
	basePath := flag.String("base", "", "api/schema/base.yaml — source of the info block")
	outJSON := flag.String("out-json", "", "canonical JSON output path")
	outYAML := flag.String("out-yaml", "", "canonical YAML output path")
	flag.Parse()

	if *in == "" || *basePath == "" || *outJSON == "" || *outYAML == "" {
		log.Fatal("-in, -base, -out-json and -out-yaml are all required")
	}

	raw, err := os.ReadFile(*in)
	if err != nil {
		log.Fatalf("read %s: %v", *in, err)
	}

	var spec map[string]any
	if err := yaml.Unmarshal(raw, &spec); err != nil {
		log.Fatalf("parse %s: %v", *in, err)
	}

	rawBase, err := os.ReadFile(*basePath)
	if err != nil {
		log.Fatalf("read %s: %v", *basePath, err)
	}

	var base map[string]any
	if err := yaml.Unmarshal(rawBase, &base); err != nil {
		log.Fatalf("parse %s: %v", *basePath, err)
	}

	if err := Transform(spec, PublicMethodPaths(), base); err != nil {
		log.Fatalf("transform: %v", err)
	}

	// Indented JSON so the drift diff is readable line-by-line.
	encoded, err := json.MarshalIndent(spec, "", "  ")
	if err != nil {
		log.Fatalf("encode json: %v", err)
	}
	if err := os.WriteFile(*outJSON, append(encoded, '\n'), 0o644); err != nil {
		log.Fatalf("write %s: %v", *outJSON, err)
	}

	asYAML, err := yaml.Marshal(spec)
	if err != nil {
		log.Fatalf("encode yaml: %v", err)
	}
	if err := os.WriteFile(*outYAML, asYAML, 0o644); err != nil {
		log.Fatalf("write %s: %v", *outYAML, err)
	}

	paths, _ := spec["paths"].(map[string]any)
	log.Printf("wrote %d paths to %s and %s", len(paths), *outJSON, *outYAML)
}
