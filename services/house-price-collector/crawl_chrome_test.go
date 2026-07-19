package main

import "testing"

func TestChromeCDPPort(t *testing.T) {
	cases := []struct {
		in      string
		want    string
		wantErr bool
	}{
		{"http://localhost:9333", "9333", false},
		{"http://localhost:9333/json/version", "9333", false},
		{"http://host.docker.internal:9222", "9222", false},
		{"http://127.0.0.1:9222/", "9222", false},
		{"", "", true},
		{"http://localhost", "", true}, // no port
	}
	for _, c := range cases {
		got, err := chromeCDPPort(c.in)
		if c.wantErr {
			if err == nil {
				t.Errorf("chromeCDPPort(%q): want error, got %q", c.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("chromeCDPPort(%q): unexpected error %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("chromeCDPPort(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
