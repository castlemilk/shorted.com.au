package broadcast

import (
	"fmt"
	"html"
	"strings"
)

const senderFooter = "Gamma Systems Pty Ltd · ABN 52 682 863 690 · shorted.com.au · support@shorted.com.au"

// defaultSiteURL is used when the caller passes an empty siteURL (tests, local).
const defaultSiteURL = "https://shorted.com.au"

// siteBase normalises the site URL to an absolute origin with no trailing slash.
func siteBase(siteURL string) string {
	s := strings.TrimRight(strings.TrimSpace(siteURL), "/")
	if s == "" {
		return defaultSiteURL
	}
	return s
}

// brandHeader renders the Shorted logo lockup (mascot mark + wordmark) for the
// dark email shell. The mark is a ~2.8KB PNG served from the web app; the
// wordmark is live text so the brand still reads if images are blocked.
func brandHeader(siteURL string) string {
	base := siteBase(siteURL)
	return fmt.Sprintf(`<a href="%s" style="text-decoration:none"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px"><tr>`+
		`<td style="vertical-align:middle;padding-right:10px"><img src="%s/email/logo.png" width="38" height="32" alt="Shorted" style="display:block;border:0;outline:none;height:32px;width:38px"/></td>`+
		`<td style="vertical-align:middle;font-size:20px;font-weight:700;letter-spacing:3px;color:#ff9a3d;text-transform:uppercase;font-family:Helvetica,Arial,sans-serif">Shorted</td>`+
		`</tr></table></a>`, base, base)
}

// RenderHTML wraps body HTML in the branded shell with a compliant footer.
// siteURL is the public origin (PUBLIC_SITE_URL) used for absolute asset links;
// unsubURL is the per-recipient tokenised unsubscribe link.
//
// Email-client robustness: the dark canvas is painted by a full-width bgcolor
// TABLE (Gmail/Outlook drop a background set only on <body>), the fixed width
// comes from an MSO ghost table (Outlook's Word engine ignores max-width on a
// div), and the inner div carries its own text colour so headings/footer stay
// light-on-dark even if the client strips <body> styles.
func RenderHTML(siteURL, title, bodyHTML, unsubURL string) string {
	u := html.EscapeString(unsubURL)
	return fmt.Sprintf(`<!doctype html><html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta http-equiv="X-UA-Compatible" content="IE=edge"/></head>
<body style="margin:0;padding:0;background:#0b0f16;color:#e7edf5;font-family:Helvetica,Arial,sans-serif">
<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0b0f16" style="background:#0b0f16;margin:0;padding:0"><tr><td align="center" style="padding:0">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<div style="max-width:600px;margin:0 auto;padding:24px;color:#e7edf5">
%s
<h1 style="font-size:24px;color:#f4f6fa;margin:0 0 16px">%s</h1>
<div style="font-size:15px;line-height:1.6;color:#cdd6e3">%s</div>
<hr style="border:none;border-top:1px solid #233044;margin:32px 0"/>
<div style="font-size:12px;color:#8b97a8">
<p>%s</p>
<p>You're receiving this because you subscribed at shorted.com.au.
<a href="%s" style="color:#ff9a3d">Unsubscribe</a>.</p>
</div></div>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`, brandHeader(siteURL), html.EscapeString(title), bodyHTML, senderFooter, u)
}

// RenderText is the plaintext alternative.
func RenderText(title, bodyText, unsubURL string) string {
	return fmt.Sprintf("%s\n\n%s\n\n—\n%s\nUnsubscribe: %s\n", title, bodyText, senderFooter, unsubURL)
}
