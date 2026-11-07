package ownership

import "testing"

// The ACN, ABN and ARSN tails cut a holder only when digits follow the word;
// the same cases are pinned on the Python side (test_notice_direct.py).
func TestTidyHolderNameCutsAnACNOrABNOnlyWithItsDigits(t *testing.T) {
	cases := []struct {
		name, want string
	}{
		{"EC Pohl & Co Pty Ltd ACN 154 399 916", "EC Pohl & Co Pty Ltd"},
		{"Acme Holdings Ltd (ACN 000 000 019)", "Acme Holdings Ltd"},
		{"Acme Pty Ltd ACN:154399916", "Acme Pty Ltd"},
		{"Acme Pty Ltd ABN 12 004 085 616", "Acme Pty Ltd"},
		{"The ABN AMRO Group", "The ABN AMRO Group"},
		{"ABN AMRO Clearing Sydney Pty Ltd", "ABN AMRO Clearing Sydney Pty Ltd"},
		{"Citigroup and ABN AMRO Bank", "Citigroup and ABN AMRO Bank"},
		{"Smith ACN Holdings", "Smith ACN Holdings"},
		{"Acnova Ltd", "Acnova Ltd"},
	}
	for _, c := range cases {
		if got := tidyHolderName(c.name); got != c.want {
			t.Errorf("tidyHolderName(%q) = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestHolderKeyOfAnACNTailGroupsWithTheRegistryName(t *testing.T) {
	if holderKey("EC Pohl & Co Pty Ltd ACN 154 399 916") != holderKey("EC Pohl & Co Pty Ltd") {
		t.Fatalf("an ACN tail must key the holder as its registry name")
	}
	if holderKey("Citigroup and ABN AMRO Bank") != "name:citigroup and abn amro bank" {
		t.Fatalf("a bare ABN inside a name must not cut it: got %q", holderKey("Citigroup and ABN AMRO Bank"))
	}
}
