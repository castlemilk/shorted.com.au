package features

import (
	"reflect"
	"testing"
)

// AsOf reads its window from a pooled buffer. A result must not alias that
// buffer: a call on another series in between must leave an earlier result as
// it was, and a repeated call must return the same value.
func TestAsOfResultsDoNotAliasThePooledWindow(t *testing.T) {
	last := day(t, "2024-03-29")
	fs := v0FS1(t)
	mk := func(n, phase int) []Bar {
		return series(last, n, func(i int) Bar {
			c := 10 + float64((i+phase)%37)/10
			return Bar{Open: c, High: c + 0.4, Low: c - 0.4, Close: c, AdjClose: c, Volume: float64(100 + (i+phase)%11)}
		})
	}
	a := mk(300, 0)
	b := mk(90, 5)
	first, okFirst := AsOf(a, nil, last, fs)
	if !okFirst {
		t.Fatal("expected features for the first series")
	}
	snapshot := first
	for k := 0; k < 25; k++ {
		if _, ok := AsOf(b, nil, last, fs); !ok && k == 0 {
			t.Fatal("expected features for the second series")
		}
	}
	if !reflect.DeepEqual(first, snapshot) {
		t.Fatal("a later call changed an earlier result")
	}
	again, _ := AsOf(a, nil, last, fs)
	if !reflect.DeepEqual(first, again) {
		t.Fatal("a repeated call gave a different result")
	}
}
