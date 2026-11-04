package spec

import (
	"fmt"
	"math"
	"regexp"
	"strings"
)

// Rule prose is generated from a version's own parameters, so the text a
// reader sees states the thresholds the version tests. A template names each
// parameter as {key} (the value), {abs:key} (its magnitude) or {x100:key} (the
// value times 100, for a fraction shown as a percentage). Values render with
// %g.

var placeholder = regexp.MustCompile(`\{(abs:|x100:)?([a-z_0-9]+)\}`)

// proseTemplates holds one template per rule id.
var proseTemplates = map[string]string{
	"growth":                "Pass when the latest annual revenue or EPS is up at least {min_pct}% on the same series a year earlier, or the company has swung from a net loss to a net profit.",
	"eps_growth":            "Pass when EPS is up at least {min_pct}% on the same series a year earlier.",
	"revenue_growth":        "Pass when revenue is up at least {min_pct}% on the same series a year earlier.",
	"base":                  "Pass when the stock has consolidated for at least {min_sessions} sessions since first setting its high over the prior {window_sessions} sessions, the base is no more than {max_depth_pct}% deep from that high to its low, and the close is at or above the base low.",
	"breakout":              "Pass when any of the last {window_sessions} sessions closed above the highest high of the {prior_sessions} sessions before it, on volume at least {volume_multiple} times the {volume_sessions}-session average.",
	"regime":                "Read from the S&P/ASX 200: pass unless it trades below its {sma_slow}-day average, uptrend when it is above its {sma_fast}-day average and that average is above the {sma_slow}-day average.",
	"rs":                    "Pass when the stock's {lookback_months}-month return beats the S&P/ASX 200's over the same period, so relative strength is above {min_points} points.",
	"liquidity":             "Pass when the average daily turnover over the last {sessions} sessions is at least A${min_aud}.",
	"near_high":             "Pass when the close is no more than {abs:max_off_pct}% below its 52-week high.",
	"rs_leader":             "Pass when the stock's 6-month relative strength is at or above the {x100:quantile}th percentile of every stock evaluated that day.",
	"trend_stack":           "Pass when the close is above the {sma_mid}-day average and the {sma_mid}-day average is above the {sma_slow}-day average.",
	"sma200_rising":         "Pass when the {sma_slow}-day average is higher than it was {lag_sessions} sessions earlier.",
	"above_low":             "Pass when the close is at least {multiple} times the 52-week low.",
	"off_high":              "Pass when the close is no more than {abs:max_off_pct}% below its 52-week high.",
	"above_sma50":           "Pass when the close is above the {sma}-day average.",
	"short_interest":        "Pass when the latest reported short position is at least {min_pct}% of shares on issue.",
	"days_to_cover":         "Pass when the latest reported short position covers at least {min} days of average volume.",
	"roe":                   "Pass when return on equity is at least {min_pct}%.",
	"net_margin":            "Pass when net profit is at least {min_pct}% of revenue for the same period.",
	"cash_conversion":       "Pass when free cash flow is positive and at least {min} times net profit for the same period.",
	"leverage":              "Pass when the company holds net cash, or its net debt is no more than {max_multiple} times EBITDA.",
	"above_sma200":          "Pass when the close is above the {sma}-day average.",
	"revenue_not_shrinking": "Pass when revenue growth is at least {min_pct}%.",
}

// RenderRule returns the prose of one rule of a version. It fails when the
// template and the rule's parameters disagree, so the test suite catches a
// renamed parameter.
func RenderRule(r RuleSpec) (string, error) {
	tmpl, ok := proseTemplates[r.ID]
	if !ok {
		return "", fmt.Errorf("no prose for rule %q", r.ID)
	}
	var missing []string
	out := placeholder.ReplaceAllStringFunc(tmpl, func(m string) string {
		parts := placeholder.FindStringSubmatch(m)
		mode, key := parts[1], parts[2]
		v, ok := r.Params[key]
		if !ok {
			missing = append(missing, key)
			return m
		}
		switch mode {
		case "abs:":
			v = math.Abs(v)
		case "x100:":
			v = math.Round(v*100*1e9) / 1e9
		}
		return fmt.Sprintf("%g", v)
	})
	if len(missing) > 0 {
		return "", fmt.Errorf("rule %q: template uses parameters the rule does not have: %s", r.ID, strings.Join(missing, ", "))
	}
	return out, nil
}

// ProseTemplateKeys returns the parameter keys a rule's template names, for
// the test that every parameter appears in the text.
func ProseTemplateKeys(ruleID string) []string {
	tmpl := proseTemplates[ruleID]
	var keys []string
	for _, m := range placeholder.FindAllStringSubmatch(tmpl, -1) {
		keys = append(keys, m[2])
	}
	return keys
}
