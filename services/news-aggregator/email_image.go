package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// emailImageSignature signs the canonical message `${rawURL}|${width}`.
// It MUST match web/src/@/lib/email-image.ts byte-for-byte — a parity test
// (TestEmailImageSignatureParity) pins a shared vector so they can't drift.
func emailImageSignature(rawURL string, width int, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(rawURL + "|" + strconv.Itoa(width)))
	return hex.EncodeToString(mac.Sum(nil))
}

// emailImageURL builds a signed proxy URL for an upstream image, resized to
// `width` display px by the /api/email/img route. Returns "" (→ no thumbnail,
// text-only card) when inputs are unusable: no secret, no site origin, or a
// non-absolute image URL.
func emailImageURL(siteURL, secret, rawURL string, width int) string {
	base := strings.TrimRight(strings.TrimSpace(siteURL), "/")
	if base == "" || secret == "" || rawURL == "" {
		return ""
	}
	if !strings.HasPrefix(rawURL, "http://") && !strings.HasPrefix(rawURL, "https://") {
		return ""
	}
	q := url.Values{}
	q.Set("u", rawURL)
	q.Set("w", strconv.Itoa(width))
	q.Set("s", emailImageSignature(rawURL, width, secret))
	return fmt.Sprintf("%s/api/email/img?%s", base, q.Encode())
}
