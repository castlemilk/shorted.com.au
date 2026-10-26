package alerts

import (
	"net/url"
	"strings"
)

// usableLogo returns raw when the email can show it as a 40x40 (or 20x20) logo, and
// "" otherwise, in which case the email draws the monogram. A logo qualifies only as
// an https raster image, judged by the path's extension in any case, with any query
// string ignored. SVG and WEBP are not shown in every client the alert reaches, and a
// wordmark forced into a square would be unreadable, so neither is used.
func usableLogo(raw string) string {
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return ""
	}
	p := strings.ToLower(u.Path)
	for _, ext := range []string{".png", ".jpg", ".jpeg"} {
		if strings.HasSuffix(p, ext) {
			return raw
		}
	}
	return ""
}
