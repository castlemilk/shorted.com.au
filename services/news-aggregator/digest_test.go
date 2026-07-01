package main

import (
	"strings"
	"testing"
)

func TestRenderCardHTMLWithImage(t *testing.T) {
	cfg := digestCfg{siteURL: "https://shorted.com.au", imgSecret: "s"}
	it := digestItem{title: "BHP tumbles", url: "https://afr.com/x", imageURL: "https://img.afr.com/p.jpg", source: "afr.com"}
	h := renderCardHTML(cfg, it)
	if !strings.Contains(h, "/api/email/img?") {
		t.Fatal("expected signed proxy thumbnail")
	}
	if !strings.Contains(h, "BHP tumbles") || !strings.Contains(h, "afr.com") {
		t.Fatal("missing title/source")
	}
	if !strings.Contains(h, `href="https://afr.com/x"`) {
		t.Fatal("missing article link")
	}
	if strings.Contains(h, `src="https://img.afr.com/p.jpg"`) {
		t.Fatal("should proxy, not hotlink the raw upstream image")
	}
}

func TestRenderCardHTMLNoImage(t *testing.T) {
	cfg := digestCfg{siteURL: "https://shorted.com.au", imgSecret: "s"}
	it := digestItem{title: "No pic", url: "https://x/y", source: "x"}
	h := renderCardHTML(cfg, it)
	if strings.Contains(h, "<img") {
		t.Fatal("no-image card must not contain an <img>")
	}
	if !strings.Contains(h, "No pic") {
		t.Fatal("missing title")
	}
}

func TestRenderCardHTMLNoSecretDegradesToText(t *testing.T) {
	cfg := digestCfg{siteURL: "https://shorted.com.au", imgSecret: ""}
	it := digestItem{title: "Has pic but no secret", url: "https://x/y", imageURL: "https://img/x.jpg", source: "x"}
	h := renderCardHTML(cfg, it)
	if strings.Contains(h, "<img") {
		t.Fatal("without a secret we cannot sign — must degrade to a text card")
	}
}

func TestRenderCardHTMLEscapesTitle(t *testing.T) {
	cfg := digestCfg{siteURL: "https://shorted.com.au", imgSecret: "s"}
	it := digestItem{title: `A <b>bold</b> "q" & <script>x</script>`, url: "https://x/y", source: "x"}
	h := renderCardHTML(cfg, it)
	if strings.Contains(h, "<script>") || strings.Contains(h, "<b>bold") {
		t.Fatalf("title not escaped: %s", h)
	}
}

func TestBuildDigestBody(t *testing.T) {
	cfg := digestCfg{siteURL: "https://shorted.com.au", imgSecret: "s"}
	news := []digestItem{{title: "N1", url: "https://a/1", source: "a"}}
	takes := []digestItem{{title: "T1", url: "https://shorted.com.au/news/t1", source: "Shorted newsroom"}}
	h, txt := buildDigestBody(cfg, news, takes)
	for _, want := range []string{"Top news", "From the newsroom", "N1", "T1"} {
		if !strings.Contains(h, want) {
			t.Errorf("html missing %q", want)
		}
	}
	if !strings.Contains(txt, "Top news") || !strings.Contains(txt, "From the newsroom") {
		t.Error("text missing sections")
	}
}

func TestBuildDigestBodyOmitsNewsroomWhenNoTakes(t *testing.T) {
	cfg := digestCfg{siteURL: "https://shorted.com.au", imgSecret: "s"}
	h, _ := buildDigestBody(cfg, []digestItem{{title: "N1", url: "https://a/1"}}, nil)
	if strings.Contains(h, "From the newsroom") {
		t.Error("newsroom heading should be omitted when there are no takes")
	}
}

func TestHostOf(t *testing.T) {
	cases := map[string]string{
		"https://www.afr.com/x": "afr.com",
		"https://News.com.au/y":  "news.com.au",
		"":                       "",
	}
	for in, want := range cases {
		if got := hostOf(in); got != want {
			t.Errorf("hostOf(%q)=%q want %q", in, got, want)
		}
	}
}
