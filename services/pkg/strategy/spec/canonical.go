package spec

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

// Canonical returns the canonical encoding of s: encoding/json over the struct
// as declared (fixed field order), with map keys sorted and no indentation.
// Floats use encoding/json's shortest round-trip form, so the bytes are a
// function of the values alone.
func Canonical(s Spec) ([]byte, error) {
	return json.Marshal(s)
}

// RulesHash is hex(sha256(Canonical(s))): 64 hex characters. The product shows
// the first eight.
func RulesHash(s Spec) (string, error) {
	b, err := Canonical(s)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}
