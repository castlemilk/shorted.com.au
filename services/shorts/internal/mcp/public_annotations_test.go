package mcp

import (
	"context"
	"encoding/json"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// Inspect the SDK's serialized catalog, including tools registered outside
// Registry, so missing false-valued hints cannot hide behind Go zero values.
func TestPublicToolAnnotationsOnTheWire(t *testing.T) {
	ctx := context.Background()
	clientTransport, serverTransport := sdk.NewInMemoryTransports()
	serverSession, err := NewServer(&fakeDataSource{}).Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer serverSession.Close()
	client := sdk.NewClient(&sdk.Implementation{Name: "public-annotations", Version: "0.1.0"}, nil)
	session, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	result, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Tools) == 0 {
		t.Fatal("public catalog is empty")
	}
	for _, tool := range result.Tools {
		t.Run(tool.Name, func(t *testing.T) {
			data, err := json.Marshal(tool)
			if err != nil {
				t.Fatal(err)
			}
			var wire struct {
				Annotations map[string]any `json:"annotations"`
			}
			if err := json.Unmarshal(data, &wire); err != nil {
				t.Fatal(err)
			}
			for name, want := range map[string]bool{"readOnlyHint": true, "destructiveHint": false, "openWorldHint": false} {
				if got, ok := wire.Annotations[name].(bool); !ok || got != want {
					t.Errorf("serialized %s = %v, want explicit %v", name, wire.Annotations[name], want)
				}
			}
		})
	}
}
