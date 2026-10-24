package main

import (
	"strings"
	"testing"

	"google.golang.org/genai"
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
		"cpi.annual_change.all_groups.aus",
		"cpi.index.all_groups.aus",
		"labour.unemployment_rate.total.{state}.seasadj",
		"labour.job_vacancies.{state}",
		"wages.wpi_yoy.{state}",
		"wages.real_wpi_yoy.{state}",
		"commodities.price_index.bulk.aus",
		"credit.growth_yoy.housing.aus.seasadj",
		"markets.short_interest_wavg.{state}",
		"markets.short_interest_avg.{industry}.aus",
		"trade.balance.total.{state}",
		"spending.household.total.{state}.seasadj",
		"lending.new_commitments.investor.{state}.seasadj",
		"business.gross_operating_profit.{industry}.aus.seasadj",
		"construction.work_done.total.{state}.seasadj",
		"crime.victims.{offence}.{state}",
		"crime.victims_rate_100k.{offence}.{state}",
		"nsw/vic/qld/sa/wa/tas/nt/act",
		"Business industry values (ANZSIC divisions): mining, manufacturing, retail-trade",
		"Market industry values (GICS): materials, energy, banks",
		"Offence values: homicide, assault, sexual-assault, robbery, unlawful-entry, motor-vehicle-theft, other-theft",
	}
	if strings.Contains(economicTool.Description, "cpi.annual_change.aus") {
		t.Error("tool description contains the nonexistent CPI key cpi.annual_change.aus")
	}
	if strings.Contains(economicTool.Description, "Industry examples:") {
		t.Error("tool description must not present one ambiguous industry vocabulary")
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

	tools := buildGeminiTools(chatToolDefinitions())
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

func TestAnswerWithoutDataIsDeclaredToTheModelButIsNotAShortsCall(t *testing.T) {
	// The contract tests require every tool in GetToolDefinitions to map to an
	// API call. answer_without_data makes none, so it must stay out of that list.
	for _, def := range GetToolDefinitions() {
		if def.Name == answerWithoutDataTool {
			t.Fatalf("%s is in GetToolDefinitions, but it makes no Shorts API call", answerWithoutDataTool)
		}
	}

	declarations := buildGeminiTools(chatToolDefinitions())[0].FunctionDeclarations
	if len(declarations) != len(GetToolDefinitions())+1 {
		t.Fatalf("declarations = %d, want every data tool plus %s", len(declarations), answerWithoutDataTool)
	}

	var declaration *genai.FunctionDeclaration
	for _, d := range declarations {
		if d.Name == answerWithoutDataTool {
			declaration = d
		}
	}
	if declaration == nil {
		t.Fatalf("%s is not declared to the model", answerWithoutDataTool)
	}
	// Gemini rejects an object schema with no properties, so a tool with no
	// parameters must declare none.
	if declaration.Parameters != nil {
		t.Fatalf("parameters = %+v, want none", declaration.Parameters)
	}
	for _, fragment := range []string{"ONLY", "NEVER", "figure"} {
		if !strings.Contains(declaration.Description, fragment) {
			t.Errorf("description missing %q: %s", fragment, declaration.Description)
		}
	}
}
