package alertspec

// Truth is a three-valued (Kleene) logic value. Unknown is what a condition
// reads when its data is missing for the session: it never counts as a match,
// and it never counts as a miss either. The zero value is False, so a missing
// state row reads as "not matching".
type Truth uint8

const (
	False Truth = iota
	True
	Unknown
)

// FromBool lifts an ordinary boolean into Truth.
func FromBool(b bool) Truth {
	if b {
		return True
	}
	return False
}

// String names the value for logs and tests.
func (t Truth) String() string {
	switch t {
	case True:
		return "true"
	case False:
		return "false"
	default:
		return "unknown"
	}
}

// and is Kleene conjunction: any False makes the result False; otherwise any
// Unknown makes it Unknown; otherwise True. The empty conjunction is True.
func and(vs ...Truth) Truth {
	out := True
	for _, v := range vs {
		switch v {
		case False:
			return False
		case Unknown:
			out = Unknown
		}
	}
	return out
}

// or is Kleene disjunction: any True makes the result True; otherwise any
// Unknown makes it Unknown; otherwise False. The empty disjunction is False.
func or(vs ...Truth) Truth {
	out := False
	for _, v := range vs {
		switch v {
		case True:
			return True
		case Unknown:
			out = Unknown
		}
	}
	return out
}

// not is Kleene negation. The negation of Unknown is Unknown.
func not(v Truth) Truth {
	switch v {
	case True:
		return False
	case False:
		return True
	default:
		return Unknown
	}
}
