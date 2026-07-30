package influence

import (
	"regexp"
	"testing"
)

// Every candidate_raw below was taken verbatim from register_item_securities in
// the loaded corpus. Synthetic strings would prove the regexps match themselves;
// these prove the classifier survives how members actually write.

func TestEntityKindOf(t *testing.T) {
	cases := []struct {
		name   string
		raw    string
		reject string
		status string
		want   string
	}{
		// --- private companies (privateCompanyMarkerRe) ----------------------
		{"pty ltd", "Emu Foot Holdings Pty Ltd", "", "not_a_security", entityKindPrivateCompany},
		{"pty limited", "Sondrio Pty Limited", "", "not_a_security", entityKindPrivateCompany},
		{"uppercase pty ltd", "PEAK PROPERTIES PTY LTD", "", "not_a_security", entityKindPrivateCompany},
		{"p/l abbreviation", "GILBERT FRANK INVESTMENTS P/L", "", "not_a_security", entityKindPrivateCompany},
		{"pty ltd with abn", "Pearce Concrete Pty Ltd ABN 20120873725", "", "not_a_security", entityKindPrivateCompany},
		{"two pty ltds in one cell", "Kenley Dale Pty Ltd Fairbank Tower Pty Ltd", "", "not_a_security", entityKindPrivateCompany},

		// --- family trusts ---------------------------------------------------
		{"family trust", "Savute Family Trust", "", "not_a_security", entityKindFamilyTrust},
		{"ampersand family trust", "CE & TS Boyce Family Trust", "", "not_a_security", entityKindFamilyTrust},
		// The trustee company is a Pty Ltd, but what is DECLARED is the trust.
		{"pty ltd trustee for a family trust", "Klare (Qld) Pty Ltd Trustee for K & A Pitt Family Trust", "", "not_a_security", entityKindFamilyTrust},

		// --- self-managed super ----------------------------------------------
		{"superannuation fund", "Williams Superannuation Fund", "", "not_a_security", entityKindSMSF},
		{"uppercase super fund", "OLESTA AND ANDREW LAMING SUPERANNUATION FUND", "", "not_a_security", entityKindSMSF},
		{"smsf acronym", "BJS SMSF Investments Pty Ltd", "", "not_a_security", entityKindSMSF},
		// Both the Pty arm and the super arm match; the VEHICLE wins.
		{"pty ltd trustee of an smsf", "Kenley Dale Pty Ltd (trustee of self-managed superannuation fund)", "", "not_a_security", entityKindSMSF},
		{"pty ltd trustee of a super fund", "Griff-Dev Investments Pty Ltd as trustee of the P&M Fletcher Superannuation Fund", "", "not_a_security", entityKindSMSF},

		// --- not an entity at all: rejected by the splitter -------------------
		{"gift log date prefix", "24/09/13 Qantas SYD-CBR", "gift_log_line", "not_a_security", entityKindNotAnEntity},
		{"gift log quantity prefix", "12 bottles of Credaro Sauvignon Blanc", "gift_log_line", "not_a_security", entityKindNotAnEntity},
		{"gift term", "Flight Upgrades", "not_a_security_term", "not_a_security", entityKindNotAnEntity},
		{"travel term", "Airfares", "not_a_security_term", "not_a_security", entityKindNotAnEntity},
		{"bare year", "2017", "not_a_security_term", "not_a_security", entityKindNotAnEntity},
		{"nil marker", "Not Applicable", "not_a_security_term", "not_a_security", entityKindNotAnEntity},
		// A reject wins even when the text names a trust: it is a log line, and
		// labelling it "Family trust" would dress prose up as a declaration.
		{"reject beats a trust marker", "please remove Superannuation Fund-Listed", "prose", "not_a_security", entityKindNotAnEntity},
		// A curated 'noise' alias (000097) reaches not_a_security with no Reject
		// set. A human already decided it names nothing, so it must not fall
		// through to 'listed' and earn a "not matched to an ASX listing" line.
		{"curated noise alias", "Applicable", "", "not_a_security", entityKindNotAnEntity},
		{"curated noise fragment", "See attached", "", "not_a_security", entityKindNotAnEntity},

		// --- listed ----------------------------------------------------------
		{"resolved listing", "Commonwealth Bank of Australia", "", "resolved", entityKindListed},
		{"unmatched plausible listing", "Bellzone Mining PLC", "", "unmatched", entityKindListed},
		{"ambiguous listing", "Sandalwood", "", "ambiguous", entityKindListed},
		// A curated alias can resolve a name that carries a private marker; if it
		// matched a listing it IS one, and the marker must not override that.
		{"resolved despite a pty marker", "Macquarie Bank Pty Ltd", "", "resolved", entityKindListed},

		// --- managed fund ----------------------------------------------------
		{"curated unlisted fund", "Bennelong Australian Equities", "", "unlisted_fund", entityKindManagedFund},
		{"unlisted fund named as a trust", "Vanguard Cash Reserve Family Trust", "", "unlisted_fund", entityKindManagedFund},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := SecurityCandidate{Raw: tc.raw, Reject: tc.reject}
			// A single-candidate cell: ask the real function whether the cell
			// carries a security signal, rather than assuming one.
			c.CellHasSecuritySignal = cellHasSecuritySignal([]SecurityCandidate{c}, nil)
			if got := entityKindOf(c, tc.status); got != tc.want {
				t.Fatalf("entityKindOf(%q, %q) = %q, want %q", tc.raw, tc.status, got, tc.want)
			}
		})
	}
}

// The three markers must partition privateCompanyRe exactly. If they ever drift
// apart, a candidate could be vetoed from ticker matching as "private" and then
// labelled 'listed' — telling a reader we failed to match an ASX listing that
// was never one.
func TestPrivateMarkersCoverPrivateCompanyRe(t *testing.T) {
	corpus := []string{
		"Emu Foot Holdings Pty Ltd",
		"Sondrio Pty Limited",
		"GILBERT FRANK INVESTMENTS P/L",
		"PEAK PROPERTIES PTY LTD",
		"Savute Family Trust",
		"CE & TS Boyce Family Trust",
		"Williams Superannuation Fund",
		"BJS SMSF Investments Pty Ltd",
		"Kenley Dale Pty Ltd (trustee of self-managed superannuation fund)",
		"Proprietary Limited",
		// Negatives: nothing private about these.
		"Commonwealth Bank of Australia",
		"Bellzone Mining PLC",
		"Airfares",
		"Vanguard Australian Shares ETF",
	}
	arms := []*regexp.Regexp{smsfMarkerRe, familyTrustMarkerRe, privateCompanyMarkerRe}

	for _, s := range corpus {
		union := false
		for _, arm := range arms {
			if arm.MatchString(s) {
				union = true
				break
			}
		}
		if got := privateCompanyRe.MatchString(s); got != union {
			t.Errorf("%q: privateCompanyRe=%v but marker union=%v", s, got, union)
		}
	}
}

// A private candidate that reached the ladder's private branch must never come
// back as 'listed', because 'listed' is what drives the "not matched to an ASX
// listing" apology on the profile page.
func TestPrivateCandidatesAreNeverLabelledListed(t *testing.T) {
	aliases := map[string]SecurityAlias{}
	codes := map[string]string{}
	names := map[string]CompanyNameMapping{}
	ambiguous := map[string]int{}

	for _, raw := range []string{
		"Emu Foot Holdings Pty Ltd",
		"Savute Family Trust",
		"Williams Superannuation Fund",
		"Bolger-Wilson Investments Pty Ltd",
	} {
		c := makeCandidate(0, raw)
		if !c.Private {
			t.Fatalf("%q: expected privateCompanyRe to fire", raw)
		}
		res := resolveSecurityCandidate(c, aliases, codes, names, ambiguous, emptyWide)
		if res.Status != "not_a_security" {
			t.Fatalf("%q: status = %q, want not_a_security", raw, res.Status)
		}
		if res.EntityKind == entityKindListed || res.EntityKind == entityKindNotAnEntity {
			t.Fatalf("%q: entity_kind = %q, want a private vehicle kind", raw, res.EntityKind)
		}
	}
}
