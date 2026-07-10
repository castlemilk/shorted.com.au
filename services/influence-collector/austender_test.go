package main

import "testing"

func TestSelectAusTenderResources(t *testing.T) {
	resources := []ckanResource{
		{Name: "Data Dictionary", Format: "XLSX", URL: "https://example.test/dictionary.xlsx"},
		{Name: "AusTender Contract Notices 2017-18", Format: "CSV", URL: "https://example.test/2017-18.csv"},
		{Name: "AusTender Contract Notices 2019-20", Format: "XLSX", URL: "https://example.test/2019-20.xlsx"},
		{Name: "AusTender API", Format: "HTML", URL: "https://example.test/api"},
		{Name: "AusTender Contract Notices 2018-19", Format: "CSV", URL: "https://example.test/2018-19.csv"},
	}

	got := selectAusTenderResources(resources, 2)
	if len(got) != 2 {
		t.Fatalf("want 2 resources, got %d: %+v", len(got), got)
	}
	if got[0].Name != "AusTender Contract Notices 2019-20" {
		t.Fatalf("first resource = %q", got[0].Name)
	}
	if got[1].Name != "AusTender Contract Notices 2018-19" {
		t.Fatalf("second resource = %q", got[1].Name)
	}
}

func TestParseAusTenderCSV(t *testing.T) {
	data := []byte(`Agency Name,Contract Notice Type,Contract Notice Status,Publish Date,Amendment Publish Date,Contract ID,SON ID,Panel Arrangement,Confidentiality - Contract,Confidentiality - Contract Reason(s),Confidentiality - Outputs,Confidentiality - Outputs Reason(s),Consultancy,Consultancy Reason(s),Amendment Reason,Procurement Method,ATM ID,SON Title,Category,UNSPSC,UNSPSC Title,Applicable Publish Date,Applicable FY Year,Applicable Value,Amendments Value,Contract Value,Start Date,End Date,Description,Agency Reference ID,Supplier Name,Supplier Address,Supplier City,Supplier Postcode,Supplier Country,Supplier ABN,Contact Name,Branch,Division,Office Postcode,Applicable Publish Date AusTender,Applicable FY Year AusTender,Applicable Value AusTender
Department of Test,Original,Published,19/06/2018,,CN12345,,,,,,,,,,Open tender,,,Software,43230000,Software,19/06/2018,2017-18,1000,0,"1,250,000",1/07/2018,30/06/2019,"<p>Cloud software support</p>",REF-1,AGL ENERGY LIMITED,1 Test St,Sydney,2000,Australia,74 115 061 375,Jane Citizen,Branch,Division,2000,19/06/2018,2017-18,1000
Department of Test,Original,Published,20/06/2018,,CNBAD,,,,,,,,,,Open tender,,,Software,43230000,Software,20/06/2018,2017-18,1000,0,1000,1/07/2018,30/06/2019,No ABN,REF-2,UNKNOWN,1 Test St,Sydney,2000,Australia,NULL,Jane Citizen,Branch,Division,2000,20/06/2018,2017-18,1000
`)

	rows, err := parseAusTenderCSV(data, "https://example.test/austender.csv")
	if err != nil {
		t.Fatalf("parseAusTenderCSV: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("want 1 valid ABN row, got %d: %+v", len(rows), rows)
	}

	row := rows[0]
	if row.ContractID != "CN12345" {
		t.Fatalf("contract ID = %q", row.ContractID)
	}
	if row.SupplierABN != "74115061375" {
		t.Fatalf("supplier ABN = %q", row.SupplierABN)
	}
	if row.ContractValue != 1250000 {
		t.Fatalf("contract value = %v", row.ContractValue)
	}
	if row.Description != "Cloud software support" {
		t.Fatalf("description = %q", row.Description)
	}
	if row.PublishDate == nil || row.PublishDate.Year() != 2018 {
		t.Fatalf("publish date = %v", row.PublishDate)
	}
	if row.EndDate == nil || row.EndDate.Year() != 2019 {
		t.Fatalf("end date = %v", row.EndDate)
	}
}

func TestParseAusTenderRowsRejectsMissingColumns(t *testing.T) {
	_, err := parseAusTenderRows([][]string{
		{"Supplier Name", "Supplier ABN"},
		{"AGL ENERGY LIMITED", "74115061375"},
	}, "https://example.test/austender.csv")
	if err == nil {
		t.Fatal("expected missing-column error")
	}
}

func TestParseAusTenderDateLayouts(t *testing.T) {
	cases := map[string]string{
		"20/08/2019": "2019-08-20", // d/mm/yyyy CSV exports
		"2019-08-20": "2019-08-20", // ISO
		"08-20-19":   "2019-08-20", // excelize mm-dd-yy rendering of date-styled XLSX cells
	}
	for in, want := range cases {
		got := parseAusTenderDate(in)
		if got == nil {
			t.Fatalf("parseAusTenderDate(%q) = nil, want %s", in, want)
		}
		if got.Format("2006-01-02") != want {
			t.Fatalf("parseAusTenderDate(%q) = %s, want %s", in, got.Format("2006-01-02"), want)
		}
	}
	if parseAusTenderDate("NULL") != nil || parseAusTenderDate("") != nil {
		t.Fatal("empty/NULL dates must return nil")
	}
}

func TestParseAusTenderRowsAcceptsValueHeaderVariant(t *testing.T) {
	rows := [][]string{
		{"Agency Name", "Contract ID", "Publish Date", "Start Date", "End Date", "Value", "Description", "UNSPSC Code", "UNSPSC Title", "Procurement Method", "Supplier Name", "Supplier ABN"},
		{"Department of Defence", "CN1", "08-20-19", "05-01-19", "05-31-19", "16163.4", "Fitness Equipment", "49200000", "Fitness equipment", "Limited tender", "Acme Ltd", "51 004 085 616"},
	}
	parsed, err := parseAusTenderRows(rows, "https://example.test")
	if err != nil {
		t.Fatalf("parseAusTenderRows: %v", err)
	}
	if len(parsed) != 1 {
		t.Fatalf("parsed %d rows, want 1", len(parsed))
	}
	row := parsed[0]
	if row.ContractValue != 16163.4 {
		t.Fatalf("value = %v", row.ContractValue)
	}
	if row.PublishDate == nil || row.PublishDate.Format("2006-01-02") != "2019-08-20" {
		t.Fatalf("publish date = %v, want 2019-08-20", row.PublishDate)
	}
	if row.UNSPSC != "49200000" {
		t.Fatalf("unspsc = %q", row.UNSPSC)
	}
}
