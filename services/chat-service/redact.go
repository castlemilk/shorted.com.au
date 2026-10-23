package main

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net/url"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"

	"connectrpc.com/connect"
)

// redactedMarker replaces every secret. It is written in the same place a secret
// was, so a reader can tell that text was scrubbed rather than missing.
const redactedMarker = "[REDACTED]"

// queryKeyPattern matches a key= query parameter in a URL. It also matches the
// form a JSON encoder leaves an ampersand in (&), since structured log
// lines are JSON. The value runs to the next parameter, whitespace, quote or
// escape.
var queryKeyPattern = regexp.MustCompile(`((?:[?&]|\\u0026)key=)[^&\s"'\\]+`)

// The configured secrets. They are process-wide because the log writer and the
// structured log encoder must scrub them without a handle on the client that
// holds them. Registration happens at startup, and again when a Gemini client is
// built, so a test that builds one is covered too.
var (
	secretsMu sync.RWMutex
	secrets   []string
)

// registerSecrets adds configured secret values to the set redactSecrets
// removes. Each value is also recorded in its URL-encoded form, because the SDK
// percent-encodes what it writes into a query string.
func registerSecrets(values ...string) {
	secretsMu.Lock()
	defer secretsMu.Unlock()
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		for _, form := range []string{value, url.QueryEscape(value)} {
			if !slices.Contains(secrets, form) {
				secrets = append(secrets, form)
			}
		}
	}
}

// redactSecrets returns s with every registered secret, and the value of every
// key= query parameter in a URL, replaced by redactedMarker. Use it on any text
// that can carry a provider's error, a request URL, or a database error.
func redactSecrets(s string) string {
	secretsMu.RLock()
	values := append([]string(nil), secrets...)
	secretsMu.RUnlock()

	// Longest first, so a value that contains another is replaced whole.
	sort.Slice(values, func(i, j int) bool { return len(values[i]) > len(values[j]) })
	for _, value := range values {
		s = strings.ReplaceAll(s, value, redactedMarker)
	}
	return queryKeyPattern.ReplaceAllString(s, "${1}"+redactedMarker)
}

// redactingWriter is the writer of the standard logger. Every line the process
// writes passes through redactSecrets on its way out, so a secret that reaches a
// log call without its own redaction still does not leave the process.
type redactingWriter struct {
	dst io.Writer
}

func (w redactingWriter) Write(p []byte) (int, error) {
	if _, err := io.WriteString(w.dst, redactSecrets(string(p))); err != nil {
		return 0, err
	}
	return len(p), nil
}

// logRedacted is log.Printf for a line that may carry provider or database error
// text. The call names the redaction where the risk is.
func logRedacted(format string, args ...any) {
	log.Print(redactSecrets(fmt.Sprintf(format, args...)))
}

// providerError is the only form in which an error from the Gemini client leaves
// this package. The SDK's transport errors name the request URL, and the REST
// transport puts the API key in that URL's query string. Keeping only the
// redacted text means no later log line or client message can carry the key,
// whichever caller forgets to scrub it.
func providerError(op string, err error) error {
	return errors.New(redactSecrets(fmt.Sprintf("%s: %v", op, err)))
}

// clientMessage is the text a client sees. It is an error only so connect.NewError
// accepts it. Its wording is a sentence for a person, not a Go error string.
type clientMessage string

func (m clientMessage) Error() string { return string(m) }

// The fixed text a client sees when a turn fails. The detail stays in the logs,
// redacted. Nothing the provider or the database said reaches the client.
const (
	modelFailureMessage    = "The model could not answer. Please try again."
	internalFailureMessage = "Chat is unavailable right now. Please try again."
)

// modelFailure logs a failed model turn, redacted, and returns the client its
// generic message.
func modelFailure(err error) error {
	logRedacted("LLM error: %v", err)
	return connect.NewError(connect.CodeInternal, clientMessage(modelFailureMessage))
}

// internalFailure logs a failed store or stream operation, redacted, and returns
// the client its generic message.
func internalFailure(op string, err error) error {
	logRedacted("chat %s failed: %v", op, err)
	return connect.NewError(connect.CodeInternal, clientMessage(internalFailureMessage))
}
