package main

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestBuildEmbedText(t *testing.T) {
	tests := []struct {
		name     string
		headline string
		summary  string
		want     string
	}{
		{"headline and summary", "BHP hits record", "Miner surges on iron ore", "BHP hits record\n\nMiner surges on iron ore"},
		{"headline only", "BHP hits record", "", "BHP hits record"},
		{"trims whitespace", "  BHP  ", "  up  ", "BHP\n\nup"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, buildEmbedText(tt.headline, tt.summary))
		})
	}
}

func TestFormatVector(t *testing.T) {
	got := formatVector([]float32{0.1, -0.25, 1})
	assert.True(t, strings.HasPrefix(got, "["), "must start with [")
	assert.True(t, strings.HasSuffix(got, "]"), "must end with ]")
	assert.Equal(t, "[0.1,-0.25,1]", got)
}
