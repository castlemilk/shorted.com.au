package strategies

// RegimeVerdict is the strategy-specific sentence shown with the market
// regime. A strategy whose regime rule is core (RegimeGates) tells the reader
// to stand aside in a downtrend; one that only scores the regime cautions
// instead. A downtrend never hides picks, it changes this sentence and (for
// gating strategies) blocks triggers.
func (s Strategy) RegimeVerdict(r Regime) string {
	code := indexCode(r)
	if !r.Known() {
		if s.RegimeGates {
			return "Market regime unavailable: there is not enough recent " + code + " data to read the trend, so the market rule reads unknown and no stock can trigger until it can be read."
		}
		return "Market regime unavailable: there is not enough recent " + code + " data to read the trend."
	}
	switch r.Label {
	case RegimeUptrend:
		switch s.ID {
		case IDZangerBreakout:
			return "Green light: " + code + " is above its 50-day and 200-day averages, the backdrop Zanger wants before buying breakouts."
		case IDCANSLIM:
			return "Green light: " + code + " is in a confirmed uptrend, O'Neil's condition for buying new leaders."
		case IDMinerviniTrendTemplate:
			return "Supportive: " + code + " is in an uptrend, so stocks passing the template have the market behind them."
		case IDCrowdedShortBreakout:
			return "Supportive: " + code + " is in an uptrend, which adds buyers to any squeeze."
		}
		return "Uptrend: " + code + " is above its 50-day and 200-day averages."
	case RegimeNeutral:
		if s.RegimeGates {
			return "Be selective: " + code + " is above its 200-day average but not in a full uptrend, so favour only the strongest setups."
		}
		return "Mixed: " + code + " is above its 200-day average but not in a full uptrend."
	default:
		if s.RegimeGates {
			return "Stand aside: " + code + " is below its 200-day average. Breakouts fail more often in a falling market, so no stock can trigger until the trend turns."
		}
		return "Caution: " + code + " is below its 200-day average. This strategy does not require a rising market, but follow-through is weaker in a falling one."
	}
}

// NeutralRegimeVerdict describes the regime without a strategy's view, for
// ListStrategies.
func NeutralRegimeVerdict(r Regime) string {
	code := indexCode(r)
	if !r.Known() {
		return "Market regime unavailable: there is not enough recent " + code + " data to read the trend."
	}
	switch r.Label {
	case RegimeUptrend:
		return "Uptrend: " + code + " is above its 50-day average, with the 50-day above the 200-day."
	case RegimeNeutral:
		return "Neutral: " + code + " is above its 200-day average but not in a full uptrend."
	default:
		return "Downtrend: " + code + " is below its 200-day average."
	}
}
