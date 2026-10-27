package main

import "testing"

// Item 1(a): the charset check on its own. Zoned, bracketed and IP-shaped hosts are not
// plain names.
func TestPlainHostnameRejectsZonesAndLiterals(t *testing.T) {
	for _, h := range []string{"::ffff:127.0.0.1%.shorted.com.au", "fe80::1%.shorted.com.au", "[::1]", "127.0.0.1:443", "a_b.shorted.com.au", ""} {
		if plainHostname(h) {
			t.Errorf("plainHostname(%q) = true, want false", h)
		}
	}
	for _, h := range []string{"api.shorted.com.au", "housing-ingest-uiekqxovma-km.a.run.app"} {
		if !plainHostname(h) {
			t.Errorf("plainHostname(%q) = false, want true", h)
		}
	}
}
