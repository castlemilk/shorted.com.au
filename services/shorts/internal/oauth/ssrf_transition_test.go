package oauth

import (
	"net"
	"strings"
	"testing"
)

// IPv6 TRANSITION MECHANISMS AS AN SSRF BYPASS.
//
// checkPublicIP's IPv4 rules are well covered. Its IPv6 half was not: an
// address in 2002::/16 (6to4) or 64:ff9b::/96 (NAT64) is a public-looking IPv6
// address that CARRIES AN IPv4 ADDRESS inside it, and routing to it reaches
// that IPv4 host. So `https://[2002:a9fe:a9fe::]/client.json` is a spelling of
// 169.254.169.254 — the cloud metadata service — that passes every IPv4 rule
// because it is not an IPv4 address at all.
//
// This matters here specifically because the CIMD path FETCHES A URL AN
// UNTRUSTED CALLER SUPPLIES. It is the one place in the OAuth surface where an
// attacker chooses the destination.

// build6to4 returns 2002:AABB:CCDD:: for A.B.C.D.
func build6to4(v4 string) net.IP {
	ip := net.ParseIP(v4).To4()
	if ip == nil {
		return nil
	}
	out := make(net.IP, net.IPv6len)
	out[0], out[1] = 0x20, 0x02
	copy(out[2:6], ip)
	return out
}

// buildNAT64 returns 64:ff9b::A.B.C.D.
func buildNAT64(v4 string) net.IP {
	ip := net.ParseIP(v4).To4()
	if ip == nil {
		return nil
	}
	out := make(net.IP, net.IPv6len)
	out[0], out[1], out[2], out[3] = 0x00, 0x64, 0xff, 0x9b
	copy(out[12:16], ip)
	return out
}

func TestSixToFourTunnelsCannotSmuggleAPrivateAddress(t *testing.T) {
	// Every one of these is a public-looking IPv6 address that routes to a
	// place we refuse to fetch from.
	for _, v4 := range []string{
		"169.254.169.254", // cloud metadata — the prize
		"127.0.0.1",       // loopback
		"10.0.0.1",        // private
		"172.16.0.1",
		"192.168.1.1",
		"100.64.0.1",      // carrier-grade NAT
		"192.0.0.1",       // IETF protocol assignments
		"198.18.0.1",      // benchmarking
		"240.0.0.1",       // reserved
		"255.255.255.255", // broadcast
		"0.0.0.0",         // unspecified
	} {
		t.Run("6to4/"+v4, func(t *testing.T) {
			ip := build6to4(v4)
			if ip == nil {
				t.Fatalf("test bug: could not build a 6to4 address for %q", v4)
			}
			// Sanity-check the construction itself, so a broken helper cannot
			// make this test vacuously pass.
			if got := embeddedIPv4(ip); got == nil || !got.Equal(net.ParseIP(v4)) {
				t.Fatalf("test bug: %s does not embed %s (got %v)", ip, v4, got)
			}

			err := checkPublicIP(ip)
			if err == nil {
				t.Fatalf("%s (6to4 for %s) was ALLOWED — SSRF bypass", ip, v4)
			}
			// The refusal must say WHY, naming the embedded address, or an
			// operator reading the log cannot tell this from a DNS failure.
			if !strings.Contains(err.Error(), "embeds a refused IPv4 address") {
				t.Errorf("refusal does not explain the tunnel: %v", err)
			}
		})
	}
}

func TestNAT64TunnelsCannotSmuggleAPrivateAddress(t *testing.T) {
	for _, v4 := range []string{"169.254.169.254", "127.0.0.1", "10.0.0.1", "192.168.1.1"} {
		t.Run("nat64/"+v4, func(t *testing.T) {
			ip := buildNAT64(v4)
			if ip == nil {
				t.Fatalf("test bug: could not build a NAT64 address for %q", v4)
			}
			if got := embeddedIPv4(ip); got == nil || !got.Equal(net.ParseIP(v4)) {
				t.Fatalf("test bug: %s does not embed %s (got %v)", ip, v4, got)
			}
			if err := checkPublicIP(ip); err == nil {
				t.Fatalf("%s (NAT64 for %s) was ALLOWED — SSRF bypass", ip, v4)
			}
		})
	}
}

// The guard must not be so eager that it blocks the legitimate case. A 6to4 or
// NAT64 address carrying a PUBLIC IPv4 address is a perfectly ordinary way to
// reach a public host, and refusing it would break real clients.
func TestTransitionAddressesCarryingPublicIPv4AreAllowed(t *testing.T) {
	for _, v4 := range []string{"8.8.8.8", "203.0.113.10", "1.1.1.1"} {
		for name, ip := range map[string]net.IP{
			"6to4":  build6to4(v4),
			"nat64": buildNAT64(v4),
		} {
			if err := checkPublicIP(ip); err != nil {
				t.Errorf("%s (%s for public %s) was refused: %v", ip, name, v4, err)
			}
		}
	}
}

// An ordinary global IPv6 address embeds nothing, and must not be mistaken for
// a tunnel — otherwise embeddedIPv4 would be reading four arbitrary bytes out
// of every address and refusing on whatever they happened to spell.
func TestOrdinaryIPv6EmbedsNothing(t *testing.T) {
	for _, s := range []string{
		"2606:4700:4700::1111", // Cloudflare
		"2001:4860:4860::8888", // Google
		// Deliberately adjacent to the 6to4 prefix without being in it.
		"2003:a9fe:a9fe::",
		// Deliberately adjacent to the NAT64 prefix without being in it.
		"64:ff9c::a9fe:a9fe",
	} {
		ip := net.ParseIP(s)
		if ip == nil {
			t.Fatalf("test bug: %q is not an IP", s)
		}
		if got := embeddedIPv4(ip); got != nil {
			t.Errorf("%s was read as embedding %v — it embeds nothing", s, got)
		}
		if err := checkPublicIP(ip); err != nil {
			t.Errorf("%s was refused: %v", s, err)
		}
	}
}

// An IPv4-MAPPED address (::ffff:a.b.c.d) is a different thing again: it IS an
// IPv4 address wearing an IPv6 spelling, and checkPublicIP unmaps it before any
// rule runs. Covered for one address already; this pins the whole ruleset,
// because unmapping in the wrong order would silently skip every IPv4 rule.
func TestIPv4MappedAddressesGetTheIPv4Rules(t *testing.T) {
	for _, v4 := range []string{
		"127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1",
		"100.64.0.1", "198.18.0.1", "240.0.0.1", "0.0.0.0",
	} {
		mapped := net.ParseIP("::ffff:" + v4)
		if mapped == nil {
			t.Fatalf("test bug: ::ffff:%s is not an IP", v4)
		}
		if err := checkPublicIP(mapped); err == nil {
			t.Errorf("::ffff:%s was allowed — the IPv4 rules were skipped", v4)
		}
	}
	if err := checkPublicIP(net.ParseIP("::ffff:8.8.8.8")); err != nil {
		t.Errorf("a mapped PUBLIC address was refused: %v", err)
	}
}
