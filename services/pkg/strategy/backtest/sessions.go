package backtest

import "github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"

// Sessions returns the simulator's sessions for a recipe over the inputs, the
// ones Run steps: the window's sessions with each code that ever triggers. The
// paper track's session builder is checked against these, session by session,
// so a difference between the stored snapshot and the batch's inputs shows up
// as a difference in one session's codes rather than only in the final equity.
func Sessions(in Inputs, s spec.Spec, r spec.Recipe) ([]Session, error) {
	p, err := prepare(in, s, r, false)
	if err != nil {
		return nil, err
	}
	return p.sessions, nil
}
