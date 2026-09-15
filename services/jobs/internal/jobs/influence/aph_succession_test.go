package influence

import (
	"testing"
	"time"
)

var (
	before = time.Date(2026, 7, 25, 0, 0, 0, 0, time.UTC)
	after  = time.Date(2026, 9, 15, 0, 0, 0, 0, time.UTC)
)

func gone(id, hint, division string) successionRow {
	return successionRow{ID: id, Parliament: 48, MemberHint: hint, Division: division, Seen: before}
}

func arrived(id, hint, division string) successionRow {
	return successionRow{ID: id, Parliament: 48, MemberHint: hint, Division: division, Seen: after}
}

// The four listing edits the 2026 host move actually made. Every one must carry
// identity forward, or register-load mints a second person for the same member.
func TestPairSuccessorsAcrossTheListingEditsAPHActuallyMade(t *testing.T) {
	cases := []struct {
		name     string
		old, new string
		division string
	}{
		{"comma spacing only", "Burnell, Mr Matt, Member for Spence, SA", "Burnell, Mr Matt, Member for Spence SA", "Spence"},
		{"preferred given name", "Pasin, Mr Antony, Member for Barker, SA", "Pasin, Mr Tony, Member for Barker SA", "Barker"},
		{"full stop where the comma belongs", "France. Ms Ali, Member for Dickson, QLD", "France, Ms Ali, Member for Dickson QLD", "Dickson"},
		{"transposed surname typo corrected", "Brynes, Ms Alison, Member for Cunningham, NSW", "Byrnes, Ms Alison, Member for Cunningham NSW", "Cunningham"},
	}
	for _, c := range cases {
		pairs := pairSuccessors(
			[]successionRow{gone("old", c.old, c.division)},
			[]successionRow{arrived("new", c.new, c.division)},
		)
		if pairs["old"] != "new" {
			t.Errorf("%s: not paired (%v)", c.name, pairs)
		}
	}
}

// A by-election: former and new member share a parliament and a division. Every
// row moves host at once, so there are two departures and two arrivals. A
// division-only rule would hand one person the other's declarations.
func TestPairSuccessorsSeparatesTwoPeopleInOneDivision(t *testing.T) {
	pairs := pairSuccessors(
		[]successionRow{
			gone("old-former", "Zzformer, Mr Alan, Former Member for Aston, VIC", "Aston"),
			gone("old-current", "Zzcurrent, Ms Mary, Member for Aston, VIC", "Aston"),
		},
		[]successionRow{
			arrived("new-current", "Zzcurrent, Ms Mary, Member for Aston VIC", "Aston"),
			arrived("new-former", "Zzformer, Mr Alan, Former Member for Aston VIC", "Aston"),
		},
	)
	if pairs["old-former"] != "new-former" || pairs["old-current"] != "new-current" {
		t.Fatalf("pairs = %v, want each person paired with themselves", pairs)
	}
}

// One out, one in, different people. Must stay unpaired: load then withholds the
// new document until a person decides.
func TestPairSuccessorsNeverPairsDifferentPeopleOnDivisionAlone(t *testing.T) {
	cases := []struct{ name, old, new string }{
		{"different surname and given", "Zzsmith, Mr John, Member for Fisher, QLD", "Zzjones, Ms Kate, Member for Fisher QLD"},
		{"similar surname, different given", "Zzbrynes, Mr Paul, Member for Fisher, QLD", "Zzbyrnes, Ms Alison, Member for Fisher QLD"},
		{"short surnames within distance", "Lee, Ms Ann, Member for Fisher, QLD", "Le, Ms Ann, Member for Fisher QLD"},
		{"no given name to confirm", "Zzbrynes, Member for Fisher, QLD", "Zzbyrnes, Member for Fisher QLD"},
	}
	for _, c := range cases {
		pairs := pairSuccessors(
			[]successionRow{gone("old", c.old, "Fisher")},
			[]successionRow{arrived("new", c.new, "Fisher")},
		)
		if len(pairs) != 0 {
			t.Errorf("%s: paired %v, want none", c.name, pairs)
		}
	}
}

func TestPairSuccessorsRespectsParliamentDivisionAndOrder(t *testing.T) {
	hint := "Zzsame, Ms Jo, Member for Wills, VIC"
	t.Run("other division", func(t *testing.T) {
		if p := pairSuccessors([]successionRow{gone("o", hint, "Wills")}, []successionRow{arrived("n", hint, "Batman")}); len(p) != 0 {
			t.Errorf("paired across divisions: %v", p)
		}
	})
	t.Run("other parliament", func(t *testing.T) {
		a := arrived("n", hint, "Wills")
		a.Parliament = 47
		if p := pairSuccessors([]successionRow{gone("o", hint, "Wills")}, []successionRow{a}); len(p) != 0 {
			t.Errorf("paired across parliaments: %v", p)
		}
	})
	t.Run("listed together is not a replacement", func(t *testing.T) {
		a := arrived("n", hint, "Wills")
		a.Seen = before // discovered in the same run the departed row was last listed
		if p := pairSuccessors([]successionRow{gone("o", hint, "Wills")}, []successionRow{a}); len(p) != 0 {
			t.Errorf("paired two rows that were listed at the same time: %v", p)
		}
	})
	t.Run("no division", func(t *testing.T) {
		if p := pairSuccessors([]successionRow{gone("o", hint, "")}, []successionRow{arrived("n", hint, "")}); len(p) != 0 {
			t.Errorf("paired without a division: %v", p)
		}
	})
	t.Run("ambiguous surname", func(t *testing.T) {
		p := pairSuccessors(
			[]successionRow{gone("o", hint, "Wills")},
			[]successionRow{arrived("n1", hint, "Wills"), arrived("n2", hint, "Wills")},
		)
		if len(p) != 0 {
			t.Errorf("paired one departure with one of two identical arrivals: %v", p)
		}
	})
}

func TestOSADistance(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"BRYNES", "BYRNES", 1}, // transposition is one edit
		{"PASIN", "PASIN", 0},
		{"SMITH", "SMYTHE", 2},
		{"ABC", "", 3},
	}
	for _, c := range cases {
		if got := osaDistance(c.a, c.b); got != c.want {
			t.Errorf("osaDistance(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}
