package main

import (
	"strings"
	"testing"

	"github.com/google/generative-ai-go/genai"
)

func TestEconomicSeriesToolDeclarationAndGeminiSchema(t *testing.T) {
	var economicTool *ToolDefinition
	for i := range GetToolDefinitions() {
		definition := GetToolDefinitions()[i]
		if definition.Name == "get_economic_series" {
			economicTool = &definition
			break
		}
	}
	if economicTool == nil {
		t.Fatal("get_economic_series tool declaration is missing")
	}

	wantDescriptionFragments := []string{
		"rates.cash_rate_target.aus",
		"cpi.annual_change.aus",
		"labour.unemployment_rate.total.{state}.seasadj",
		"labour.job_vacancies.{state}",
		"wages.wpi_yoy.{state}",
		"wages.real_wpi_yoy.{state}",
		"commodities.price_index.bulk.aus",
		"credit.growth_yoy.housing.aus.seasadj",
		"markets.short_interest_wavg.{state}",
		"markets.short_interest_avg.{industry}.aus",
		"trade.balance.total.{state}",
		"nsw/vic/qld/sa/wa/tas/nt/act",
		"materials, energy, banks, software-services",
	}
	for _, fragment := range wantDescriptionFragments {
		if !strings.Contains(economicTool.Description, fragment) {
			t.Errorf("tool description missing %q", fragment)
		}
	}
	if len(economicTool.Required) != 1 || economicTool.Required[0] != "series_keys" {
		t.Fatalf("required parameters = %v, want [series_keys]", economicTool.Required)
	}
	if parameter := economicTool.Parameters["series_keys"]; parameter.Type != "array" {
		t.Fatalf("series_keys type = %q, want array", parameter.Type)
	}

	tools := buildGeminiTools()
	if len(tools) != 1 {
		t.Fatalf("buildGeminiTools() returned %d tools, want 1 tool group", len(tools))
	}
	for _, declaration := range tools[0].FunctionDeclarations {
		if declaration.Name != "get_economic_series" {
			continue
		}
		seriesKeys := declaration.Parameters.Properties["series_keys"]
		if seriesKeys.Type != genai.TypeArray {
			t.Fatalf("Gemini series_keys type = %v, want array", seriesKeys.Type)
		}
		if seriesKeys.Items == nil || seriesKeys.Items.Type != genai.TypeString {
			t.Fatalf("Gemini series_keys items = %#v, want string schema", seriesKeys.Items)
		}
		return
	}
	t.Fatal("get_economic_series Gemini declaration is missing")
}
