package picks

import "testing"

// The shadow runs only for a live -mode refresh with the switch on. -mode all
// never runs it, because its timeout leaves no room for a second comparison.
func TestParityShadowDue(t *testing.T) {
	on := func(string) string { return "on" }
	off := func(string) string { return "" }
	cases := []struct {
		name   string
		mode   string
		dryRun bool
		getenv func(string) string
		want   bool
	}{
		{"refresh with the switch on", modeRefresh, false, on, true},
		{"refresh with the switch unset", modeRefresh, false, off, false},
		{"refresh with the switch off", modeRefresh, false, func(string) string { return "off" }, false},
		{"all never runs it", modeAll, false, on, false},
		{"fundamentals never runs it", modeFundamentals, false, on, false},
		{"filings never runs it", modeFilings, false, on, false},
		{"a dry run never runs it", modeRefresh, true, on, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := parityShadowDue(c.mode, c.dryRun, c.getenv); got != c.want {
				t.Errorf("parityShadowDue(%s, dry=%v) = %v, want %v", c.mode, c.dryRun, got, c.want)
			}
		})
	}
}
