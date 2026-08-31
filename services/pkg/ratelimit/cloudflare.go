package ratelimit

import (
	"net"
	"net/netip"
	"strings"
)

// Cloudflare's published egress ranges, from https://www.cloudflare.com/ips-v4
// and /ips-v6 (fetched 2026-08-30).
//
// WHY THESE ARE HERE AT ALL. They are the only way to tell "this request came
// through our own edge, so the client-identifying headers on it were written by
// Cloudflare" from "someone hit the Cloud Run URL directly and typed those
// headers themselves". Cloud Run is publicly reachable (allUsers invoker, no
// ingress restriction), so that distinction is not theoretical.
//
// STALENESS IS SAFE, IN ONE DIRECTION. If Cloudflare adds a range we do not
// know about, requests through it fall back to the rightmost-hop rule — the
// pre-2026-08-30 behaviour, which pools callers but never mis-attributes one
// caller's traffic to another's bucket. A range we list that Cloudflare no
// longer owns is the harmful direction, so entries are only ever removed from
// the published list, never guessed at.
var cloudflareCIDRs = []string{
	// IPv4
	"173.245.48.0/20",
	"103.21.244.0/22",
	"103.22.200.0/22",
	"103.31.4.0/22",
	"141.101.64.0/18",
	"108.162.192.0/18",
	"190.93.240.0/20",
	"188.114.96.0/20",
	"197.234.240.0/22",
	"198.41.128.0/17",
	"162.158.0.0/15",
	"104.16.0.0/13",
	"104.24.0.0/14",
	"172.64.0.0/13",
	"131.0.72.0/22",
	// IPv6
	"2400:cb00::/32",
	"2606:4700::/32",
	"2803:f800::/32",
	"2405:b500::/32",
	"2405:8100::/32",
	"2a06:98c0::/29",
	"2c0f:f248::/32",
}

// Parsed once at init. A malformed entry is dropped rather than panicking the
// server: losing one range degrades to the fallback path, while refusing to
// start takes the API down over a typo in a constant.
var cloudflarePrefixes = parseCloudflarePrefixes(cloudflareCIDRs)

func parseCloudflarePrefixes(cidrs []string) []netip.Prefix {
	prefixes := make([]netip.Prefix, 0, len(cidrs))
	for _, cidr := range cidrs {
		if p, err := netip.ParsePrefix(cidr); err == nil {
			prefixes = append(prefixes, p)
		}
	}
	return prefixes
}

// isCloudflareEdge reports whether an address is one of Cloudflare's.
//
// The address is unmapped first so that an IPv4-mapped IPv6 form
// (::ffff:172.69.60.206) matches the IPv4 ranges — otherwise the same edge node
// is recognised or not depending on how the hop was written down.
func isCloudflareEdge(ip string) bool {
	addr, err := netip.ParseAddr(strings.TrimSpace(ip))
	if err != nil {
		// Some proxies write "ip:port" into a forwarded list.
		if host, _, splitErr := net.SplitHostPort(strings.TrimSpace(ip)); splitErr == nil {
			if addr, err = netip.ParseAddr(host); err != nil {
				return false
			}
		} else {
			return false
		}
	}
	addr = addr.Unmap()
	for _, p := range cloudflarePrefixes {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}
