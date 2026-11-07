package alertspec

import "testing"

func TestKleeneTables(t *testing.T) {
	vals := []Truth{False, True, Unknown}
	andWant := map[[2]Truth]Truth{
		{False, False}: False, {False, True}: False, {False, Unknown}: False,
		{True, False}: False, {True, True}: True, {True, Unknown}: Unknown,
		{Unknown, False}: False, {Unknown, True}: Unknown, {Unknown, Unknown}: Unknown,
	}
	orWant := map[[2]Truth]Truth{
		{False, False}: False, {False, True}: True, {False, Unknown}: Unknown,
		{True, False}: True, {True, True}: True, {True, Unknown}: True,
		{Unknown, False}: Unknown, {Unknown, True}: True, {Unknown, Unknown}: Unknown,
	}
	for _, a := range vals {
		for _, b := range vals {
			if got := and(a, b); got != andWant[[2]Truth{a, b}] {
				t.Errorf("and(%v, %v) = %v, want %v", a, b, got, andWant[[2]Truth{a, b}])
			}
			if got := or(a, b); got != orWant[[2]Truth{a, b}] {
				t.Errorf("or(%v, %v) = %v, want %v", a, b, got, orWant[[2]Truth{a, b}])
			}
		}
	}
	notWant := map[Truth]Truth{False: True, True: False, Unknown: Unknown}
	for _, a := range vals {
		if got := not(a); got != notWant[a] {
			t.Errorf("not(%v) = %v, want %v", a, got, notWant[a])
		}
	}
	if and() != True || or() != False {
		t.Errorf("empty and/or must be True/False")
	}
	if (Truth(0)) != Unknown {
		t.Errorf("the zero Truth must be Unknown")
	}
}
