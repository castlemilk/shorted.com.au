package absdata

import (
	"strconv"
	"strings"
	"time"
)

// PeriodDate parses an SDMX TIME_PERIOD ("2024", "2024-Q3", "2024-05") into
// the first day of the period plus a frequency label.
func PeriodDate(s string) (time.Time, string, bool) {
	s = strings.TrimSpace(s)
	switch {
	case len(s) == 4:
		y, err := strconv.Atoi(s)
		if err != nil {
			return time.Time{}, "", false
		}
		return time.Date(y, 1, 1, 0, 0, 0, 0, time.UTC), "annual", true
	case len(s) == 7 && strings.Contains(s, "-Q"):
		y, err := strconv.Atoi(s[:4])
		q, err2 := strconv.Atoi(s[6:])
		if err != nil || err2 != nil || q < 1 || q > 4 {
			return time.Time{}, "", false
		}
		return time.Date(y, time.Month((q-1)*3+1), 1, 0, 0, 0, 0, time.UTC), "quarterly", true
	case len(s) == 7 && s[4] == '-':
		y, err := strconv.Atoi(s[:4])
		m, err2 := strconv.Atoi(s[5:])
		if err != nil || err2 != nil || m < 1 || m > 12 {
			return time.Time{}, "", false
		}
		return time.Date(y, time.Month(m), 1, 0, 0, 0, 0, time.UTC), "monthly", true
	}
	return time.Time{}, "", false
}
