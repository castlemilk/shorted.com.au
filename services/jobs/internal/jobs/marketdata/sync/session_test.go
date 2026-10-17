package sync

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func mustDate(s string) time.Time {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestLastClosedSession(t *testing.T) {
	t.Parallel()
	syd := func(s string) time.Time {
		t, err := time.ParseInLocation("2006-01-02 15:04", s, sydney)
		if err != nil {
			panic(err)
		}
		return t
	}
	cases := []struct {
		name string
		now  time.Time
		want string
	}{
		// The scheduled run: 10:00 UTC on a weekday is 20:00 AEST / 21:00 AEDT.
		{"weekday evening, AEST", time.Date(2026, 9, 25, 10, 0, 0, 0, time.UTC), "2026-09-25"},
		{"weekday evening, AEDT", time.Date(2026, 11, 3, 10, 0, 0, 0, time.UTC), "2026-11-03"},
		// A daylight-time evening is still the same Sydney day, but its UTC
		// morning is the previous day: the date must come from Sydney.
		{"Monday 08:30 AEDT is Sunday in UTC", syd("2026-11-02 08:30"), "2026-10-30"},
		{"during trading, today's session is not closed", syd("2026-09-25 13:00"), "2026-09-24"},
		{"just after the close, before the bar settles", syd("2026-09-25 16:30"), "2026-09-24"},
		{"from 17:00 the session counts", syd("2026-09-25 17:00"), "2026-09-25"},
		{"Saturday is Friday's session", syd("2026-09-26 12:00"), "2026-09-25"},
		{"Sunday is Friday's session", syd("2026-09-27 23:59"), "2026-09-25"},
		{"Monday morning is Friday's session", syd("2026-09-28 09:00"), "2026-09-25"},
	}
	for _, c := range cases {
		got := lastClosedSession(c.now)
		assert.Equal(t, c.want, got.Format("2006-01-02"), c.name)
		assert.Equal(t, time.UTC, got.Location(), c.name)
	}
}

func TestWeekdaysIn(t *testing.T) {
	t.Parallel()
	assert.Equal(t, 5, weekdaysIn(mustDate("2026-09-21"), mustDate("2026-09-27")))
	assert.Equal(t, 1, weekdaysIn(mustDate("2026-09-25"), mustDate("2026-09-25")))
	assert.Equal(t, 0, weekdaysIn(mustDate("2026-09-26"), mustDate("2026-09-27")))
	assert.Equal(t, 0, weekdaysIn(mustDate("2026-09-27"), mustDate("2026-09-26")), "an empty window")
	// Easter 2026 from Thursday's close: Good Friday and Easter Monday.
	assert.Equal(t, 2, weekdaysIn(mustDate("2026-04-03"), mustDate("2026-04-06")))
	assert.LessOrEqual(t, weekdaysIn(mustDate("2026-04-03"), mustDate("2026-04-06")), maxClosedWeekdays)
}
