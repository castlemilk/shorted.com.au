package broadcast

import (
	"fmt"
	"html"
)

const senderFooter = "Gamma Systems Pty Ltd · ABN 52 682 863 690 · shorted.com.au · support@shorted.com.au"

// RenderHTML wraps body HTML in the branded shell with a compliant footer.
// unsubURL is the per-recipient tokenised unsubscribe link.
func RenderHTML(title, bodyHTML, unsubURL string) string {
	u := html.EscapeString(unsubURL)
	return fmt.Sprintf(`<!doctype html><html><body style="margin:0;background:#0b0f16;color:#e7edf5;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:24px">
<div style="font-size:14px;letter-spacing:2px;color:#ff9a3d;text-transform:uppercase">Shorted</div>
<h1 style="font-size:24px;color:#f4f6fa">%s</h1>
<div style="font-size:15px;line-height:1.6;color:#cdd6e3">%s</div>
<hr style="border:none;border-top:1px solid #233044;margin:32px 0"/>
<div style="font-size:12px;color:#8b97a8">
<p>%s</p>
<p>You're receiving this because you subscribed at shorted.com.au.
<a href="%s" style="color:#ff9a3d">Unsubscribe</a>.</p>
</div></div></body></html>`, html.EscapeString(title), bodyHTML, senderFooter, u)
}

// RenderText is the plaintext alternative.
func RenderText(title, bodyText, unsubURL string) string {
	return fmt.Sprintf("%s\n\n%s\n\n—\n%s\nUnsubscribe: %s\n", title, bodyText, senderFooter, unsubURL)
}
