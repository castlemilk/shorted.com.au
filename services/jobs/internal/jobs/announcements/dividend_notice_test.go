package announcements

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseDividendNotice(t *testing.T) {
	testDir := "testdata/dividend_notices"

	tests := []struct {
		name            string
		fixtureFile     string
		expectedOutcome noticeOutcome
		expectedNotice  *DividendNotice
		expectedDetail  string // for non-parsed outcomes
	}{
		{
			name:            "CBA final 2026-08-12",
			fixtureFile:     "cba_final_2026-08-12.txt",
			expectedOutcome: noticeParsed,
			expectedNotice: &DividendNotice{
				SecurityCode:     "CBA",
				AnnouncementType: "new",
				AnnouncedOn:      "2026-08-12",
				PeriodEnd:        "2026-06-30",
				RecordDate:       "2026-08-20",
				ExDate:           "2026-08-19",
				PaymentDate:      "2026-09-29",
				Currency:         "AUD",
				Total:            2.70,
				AUDEquivalent:    nil,
				Parts: []DividendPart{
					{
						Type:       "ordinary",
						Amount:     2.70,
						Estimated:  false,
						FrankedPct: floatPtr(100),
					},
				},
			},
		},
		{
			name:            "CBA update 2026-09-02",
			fixtureFile:     "cba_update_2026-09-02.txt",
			expectedOutcome: noticeParsed,
			expectedNotice: &DividendNotice{
				SecurityCode:     "CBA",
				AnnouncementType: "update",
				AnnouncedOn:      "2026-09-02",
				PeriodEnd:        "2026-06-30",
				RecordDate:       "2026-08-20",
				ExDate:           "2026-08-19",
				PaymentDate:      "2026-09-29",
				Currency:         "AUD",
				Total:            2.70,
				AUDEquivalent:    nil,
				Parts: []DividendPart{
					{
						Type:       "ordinary",
						Amount:     2.70,
						Estimated:  false,
						FrankedPct: floatPtr(100),
					},
				},
			},
		},
		{
			name:            "CBAPI 2026-09-17",
			fixtureFile:     "cbapi_2026-09-17.txt",
			expectedOutcome: noticeParsed,
			expectedNotice: &DividendNotice{
				SecurityCode:     "CBAPI",
				AnnouncementType: "new",
				AnnouncedOn:      "2026-09-17",
				PeriodEnd:        "2026-12-15",
				RecordDate:       "2026-12-07",
				ExDate:           "2026-12-04",
				PaymentDate:      "2026-12-15",
				Currency:         "AUD",
				Total:            1.3393,
				AUDEquivalent:    nil,
				Parts: []DividendPart{
					{
						Type:       "ordinary",
						Amount:     1.3393,
						Estimated:  false,
						FrankedPct: floatPtr(100),
					},
				},
			},
		},
		{
			name:            "BHP final 2026-08-18",
			fixtureFile:     "bhp_final_2026-08-18.txt",
			expectedOutcome: noticeParsed,
			expectedNotice: &DividendNotice{
				SecurityCode:     "BHP",
				AnnouncementType: "new",
				AnnouncedOn:      "2026-08-18",
				PeriodEnd:        "2026-06-30",
				RecordDate:       "2026-09-04",
				ExDate:           "2026-09-03",
				PaymentDate:      "2026-09-23",
				Currency:         "USD",
				Total:            0.99,
				AUDEquivalent:    nil,
				Parts: []DividendPart{
					{
						Type:       "ordinary",
						Amount:     0.99,
						Estimated:  false,
						FrankedPct: floatPtr(100),
					},
				},
			},
		},
		{
			name:            "BHP update 2026-10-08",
			fixtureFile:     "bhp_update_2026-10-08.txt",
			expectedOutcome: noticeParsed,
			expectedNotice: &DividendNotice{
				SecurityCode:     "BHP",
				AnnouncementType: "update",
				AnnouncedOn:      "2026-10-08",
				PeriodEnd:        "2026-06-30",
				RecordDate:       "2026-09-04",
				ExDate:           "2026-09-03",
				PaymentDate:      "2026-09-23",
				Currency:         "USD",
				Total:            0.99,
				AUDEquivalent:    floatPtr(1.37988710),
				Parts: []DividendPart{
					{
						Type:       "ordinary",
						Amount:     0.99,
						Estimated:  false,
						FrankedPct: floatPtr(100),
					},
				},
			},
		},
		{
			name:            "SUN final 2026-08-12",
			fixtureFile:     "sun_final_2026-08-12.txt",
			expectedOutcome: noticeParsed,
			expectedNotice: &DividendNotice{
				SecurityCode:     "SUN",
				AnnouncementType: "new",
				AnnouncedOn:      "2026-08-12",
				PeriodEnd:        "2026-06-30",
				RecordDate:       "2026-08-18",
				ExDate:           "2026-08-17",
				PaymentDate:      "2026-09-22",
				Currency:         "AUD",
				Total:            0.62,
				AUDEquivalent:    nil,
				Parts: []DividendPart{
					{
						Type:       "ordinary",
						Amount:     0.52,
						Estimated:  false,
						FrankedPct: floatPtr(100),
					},
					{
						Type:       "special",
						Amount:     0.10,
						Estimated:  false,
						FrankedPct: floatPtr(100),
					},
				},
			},
		},
		{
			name:            "Vanguard letter (not a 3A.1 form)",
			fixtureFile:     "vanguard_letter_2026-09-24.txt",
			expectedOutcome: noticeNotForm,
		},
	}

	// Synthetic test cases
	tests = append(tests,
		// Synthetic 1: SUN with modified special part amount (inconsistent)
		struct {
			name            string
			fixtureFile     string
			expectedOutcome noticeOutcome
			expectedNotice  *DividendNotice
			expectedDetail  string
		}{
			name:            "SUN with inconsistent parts (synthetic)",
			fixtureFile:     "sun_final_2026-08-12.txt",
			expectedOutcome: noticeInconsistent,
			expectedDetail:  "parts sum",
			// Will be created by modifying the fixture content in-memory
		},
		// Synthetic 2: CBA with cancellation
		struct {
			name            string
			fixtureFile     string
			expectedOutcome noticeOutcome
			expectedNotice  *DividendNotice
			expectedDetail  string
		}{
			name:            "CBA with cancellation (synthetic)",
			fixtureFile:     "cba_final_2026-08-12.txt",
			expectedOutcome: noticeCancellation,
		},
		// Synthetic 3: CBA missing ex date
		struct {
			name            string
			fixtureFile     string
			expectedOutcome noticeOutcome
			expectedNotice  *DividendNotice
			expectedDetail  string
		}{
			name:            "CBA missing ex date (synthetic)",
			fixtureFile:     "cba_final_2026-08-12.txt",
			expectedOutcome: noticeMissingField,
			expectedDetail:  "ex date",
		},
		// Synthetic 4: Minimal synthetic with 3A.5 but no 3A.3
		struct {
			name            string
			fixtureFile     string
			expectedOutcome noticeOutcome
			expectedNotice  *DividendNotice
			expectedDetail  string
		}{
			name:            "Minimal with unfranked pct (synthetic)",
			fixtureFile:     "",
			expectedOutcome: noticeParsed,
			expectedNotice: &DividendNotice{
				SecurityCode:     "TST",
				AnnouncementType: "new",
				AnnouncedOn:      "2026-10-11",
				PeriodEnd:        "2026-10-31",
				ExDate:           "2026-10-10",
				Currency:         "AUD",
				Total:            1.00,
				Parts: []DividendPart{
					{
						Type:       "ordinary",
						Amount:     1.00,
						Estimated:  false,
						FrankedPct: floatPtr(60), // 100 - 40 from 3A.5
					},
				},
			},
		},
	)

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var textStr string
			switch {
			case strings.Contains(tt.name, "inconsistent parts"):
				// Load SUN and modify special part amount
				textData, err := os.ReadFile(filepath.Join(testDir, "sun_final_2026-08-12.txt"))
				if err != nil {
					t.Fatalf("failed to read fixture: %v", err)
				}
				// Replace first AUD 0.10000000 after 3B.1b with AUD 0.20000000
				textStr = strings.Replace(
					string(textData),
					"3B.1b Special dividend/distribution amount per +security\nAUD 0.10000000",
					"3B.1b Special dividend/distribution amount per +security\nAUD 0.20000000",
					1,
				)
			case strings.Contains(tt.name, "cancellation"):
				// Load CBA final and replace "New announcement" with cancellation text
				textData, err := os.ReadFile(filepath.Join(testDir, "cba_final_2026-08-12.txt"))
				if err != nil {
					t.Fatalf("failed to read fixture: %v", err)
				}
				textStr = strings.Replace(
					string(textData),
					"New announcement",
					"Cancellation of previous announcement",
					1,
				)
			case strings.Contains(tt.name, "missing ex date"):
				// Load CBA final and remove Ex Date
				textData, err := os.ReadFile(filepath.Join(testDir, "cba_final_2026-08-12.txt"))
				if err != nil {
					t.Fatalf("failed to read fixture: %v", err)
				}
				fileStr := string(textData)
				// Remove "Ex Date" summary line and its value
				fileStr = strings.Replace(fileStr, "Ex Date\n19/8/2026", "", 1)
				// Remove 2A.5 Ex Date and value
				lines := strings.Split(fileStr, "\n")
				var filtered []string
				skipNext := false
				for _, line := range lines {
					if strings.Contains(line, "2A.5 Ex Date") {
						skipNext = true
						continue
					}
					if skipNext && line != "" && !strings.HasPrefix(strings.TrimSpace(line), "2A.") && !strings.HasPrefix(strings.TrimSpace(line), "Part ") {
						// This is the value line, skip it
						skipNext = false
						continue
					}
					if skipNext && (strings.HasPrefix(strings.TrimSpace(line), "2A.") || strings.HasPrefix(strings.TrimSpace(line), "Part ")) {
						skipNext = false
					}
					filtered = append(filtered, line)
				}
				textStr = strings.Join(filtered, "\n")
			case strings.Contains(tt.name, "unfranked pct"):
				// Create a minimal synthetic notice text
				textStr = `Appendix 3A.1 - Notification of dividend / distribution
Announcement Summary
Entity name
TEST ENTITY
Security on which the Distribution will be paid
TST - ORDINARY
Announcement Type
New announcement
Distribution Amount
AUD 1.00000000
Refer to below for full details of the announcement

1.5 Date of this announcement
11/10/2026
1.6 ASX +Security Code
TST
2A.3 The dividend/distribution relates to the financial reporting or payment period ending
31/10/2026
2A.5 Ex Date
10/10/2026
2A.8 Currency in which the dividend/distribution is made
AUD - Australian Dollar
2A.9 Total dividend/distribution payment amount per +security
AUD 1.00000000
3A.1b Ordinary Dividend/distribution amount per +security
AUD 1.00000000
3A.5 Percentage amount of dividend which is unfranked
40.0000 %
`
			default:
				if tt.fixtureFile != "" {
					textData, err := os.ReadFile(filepath.Join(testDir, tt.fixtureFile))
					if err != nil {
						t.Fatalf("failed to read fixture: %v", err)
					}
					textStr = string(textData)
				}
			}

			notice, outcome, detail := parseDividendNotice(textStr)

			if outcome != tt.expectedOutcome {
				t.Errorf("outcome: got %v, want %v (detail: %s)", outcome, tt.expectedOutcome, detail)
			}

			if tt.expectedOutcome != noticeParsed {
				if outcome != noticeCancellation && tt.expectedDetail != "" && !strings.Contains(detail, tt.expectedDetail) {
					t.Errorf("detail: got %q, expected to contain %q", detail, tt.expectedDetail)
				}
				return
			}

			// Only check notice fields if parsing succeeded
			if tt.expectedNotice == nil {
				return
			}

			// Check all fields with tolerance for floats
			const floatTol = 1e-9

			if notice.SecurityCode != tt.expectedNotice.SecurityCode {
				t.Errorf("SecurityCode: got %q, want %q", notice.SecurityCode, tt.expectedNotice.SecurityCode)
			}
			if notice.AnnouncementType != tt.expectedNotice.AnnouncementType {
				t.Errorf("AnnouncementType: got %q, want %q", notice.AnnouncementType, tt.expectedNotice.AnnouncementType)
			}
			if notice.AnnouncedOn != tt.expectedNotice.AnnouncedOn {
				t.Errorf("AnnouncedOn: got %q, want %q", notice.AnnouncedOn, tt.expectedNotice.AnnouncedOn)
			}
			if notice.PeriodEnd != tt.expectedNotice.PeriodEnd {
				t.Errorf("PeriodEnd: got %q, want %q", notice.PeriodEnd, tt.expectedNotice.PeriodEnd)
			}
			if notice.RecordDate != tt.expectedNotice.RecordDate {
				t.Errorf("RecordDate: got %q, want %q", notice.RecordDate, tt.expectedNotice.RecordDate)
			}
			if notice.ExDate != tt.expectedNotice.ExDate {
				t.Errorf("ExDate: got %q, want %q", notice.ExDate, tt.expectedNotice.ExDate)
			}
			if notice.PaymentDate != tt.expectedNotice.PaymentDate {
				t.Errorf("PaymentDate: got %q, want %q", notice.PaymentDate, tt.expectedNotice.PaymentDate)
			}
			if notice.Currency != tt.expectedNotice.Currency {
				t.Errorf("Currency: got %q, want %q", notice.Currency, tt.expectedNotice.Currency)
			}
			if absDiff(notice.Total, tt.expectedNotice.Total) > floatTol {
				t.Errorf("Total: got %v, want %v", notice.Total, tt.expectedNotice.Total)
			}

			// Check AUDEquivalent
			if notice.AUDEquivalent == nil && tt.expectedNotice.AUDEquivalent == nil {
				// OK
			} else if notice.AUDEquivalent == nil || tt.expectedNotice.AUDEquivalent == nil {
				t.Errorf("AUDEquivalent: got %v, want %v", notice.AUDEquivalent, tt.expectedNotice.AUDEquivalent)
			} else if absDiff(*notice.AUDEquivalent, *tt.expectedNotice.AUDEquivalent) > floatTol {
				t.Errorf("AUDEquivalent: got %v, want %v", *notice.AUDEquivalent, *tt.expectedNotice.AUDEquivalent)
			}

			// Check Parts
			if len(notice.Parts) != len(tt.expectedNotice.Parts) {
				t.Errorf("Parts length: got %d, want %d", len(notice.Parts), len(tt.expectedNotice.Parts))
			} else {
				for i, part := range notice.Parts {
					exp := tt.expectedNotice.Parts[i]
					if part.Type != exp.Type {
						t.Errorf("Parts[%d].Type: got %q, want %q", i, part.Type, exp.Type)
					}
					if absDiff(part.Amount, exp.Amount) > floatTol {
						t.Errorf("Parts[%d].Amount: got %v, want %v", i, part.Amount, exp.Amount)
					}
					if part.Estimated != exp.Estimated {
						t.Errorf("Parts[%d].Estimated: got %v, want %v", i, part.Estimated, exp.Estimated)
					}
					if part.FrankedPct == nil && exp.FrankedPct == nil {
						// OK
					} else if part.FrankedPct == nil || exp.FrankedPct == nil {
						t.Errorf("Parts[%d].FrankedPct: got %v, want %v", i, part.FrankedPct, exp.FrankedPct)
					} else if absDiff(*part.FrankedPct, *exp.FrankedPct) > floatTol {
						t.Errorf("Parts[%d].FrankedPct: got %v, want %v", i, *part.FrankedPct, *exp.FrankedPct)
					}
				}
			}
		})
	}
}

func floatPtr(f float64) *float64 {
	return &f
}
