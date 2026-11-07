package shorts

// market_moves_http.go is the market-moves workflow's door: two POST routes on
// the API host, authenticated by a market-moves token.
//
//	POST /v1/market-moves          post (or revise) one move
//	POST /v1/market-moves/retract  retract one move
//
// A token ("smm_...") is created by an administrator in the admin console
// (/admin/market-moves, market_moves_tokens.go) and sent as
// `Authorization: Bearer <token>` or `x-market-moves-token`. No other route
// accepts one, so a leaked token can post and retract moves and do nothing
// else, and revoking it in the console stops it within marketMovesTokenTTL.
// The INTERNAL_SERVICE_SECRET also works here, as it does on
// /api/admin/news/publish: it is a superset the admin console already holds.
//
// The body is decoded strictly: an unknown field is refused, not dropped. A
// model that writes changePct for change_pct must learn so, not see its move
// published without the figure it meant to give.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"google.golang.org/protobuf/encoding/protojson"
)

// The routes.
const (
	MarketMovesPath        = "/v1/market-moves"
	MarketMovesRetractPath = "/v1/market-moves/retract"
)

// marketMovesTokenHeader carries the token when Authorization is taken.
const marketMovesTokenHeader = "x-market-moves-token"

// marketMovesInternalActor is the audit identity of the internal secret.
const marketMovesInternalActor = "internal"

// marketMovesMaxBody bounds a request body. A move is a few KB at most.
const marketMovesMaxBody = 64 << 10

// marketMovesHandler is a handler that knows who called.
type marketMovesHandler func(w http.ResponseWriter, r *http.Request, actor string)

// marketMovesAuth accepts a market-moves token, and otherwise defers to
// adminAuthMiddleware unchanged (including its fail-closed production rule).
// A credential that looks like a token is judged as one and never falls through.
func (s *ShortsServer) marketMovesAuth(next marketMovesHandler) http.HandlerFunc {
	admin := adminAuthMiddleware(func(w http.ResponseWriter, r *http.Request) {
		next(w, r, marketMovesInternalActor)
	})
	return func(w http.ResponseWriter, r *http.Request) {
		presented := presentedMarketMovesToken(r)
		if !strings.HasPrefix(presented, marketMovesTokenScheme) {
			admin(w, r)
			return
		}
		actor, err := s.marketMovesTokens.verify(r.Context(), presented)
		switch {
		case err == nil:
			next(w, r, actor)
		case errors.Is(err, errMarketMovesTokenRefused):
			writeMarketMoveError(w, &MarketMoveError{Status: http.StatusUnauthorized, Code: "unauthorized",
				Message: "the token is unknown, revoked or expired; create a new one in the admin console (/admin/market-moves)"})
		default:
			s.logger.Errorf("market moves: verify token: %v", err)
			writeMarketMoveError(w, &MarketMoveError{Status: http.StatusServiceUnavailable, Code: "unavailable",
				Message: "the token could not be checked right now; nothing was written", Retryable: true})
		}
	}
}

// MarketMovesPublishHandler serves POST /v1/market-moves.
func (s *ShortsServer) MarketMovesPublishHandler() http.HandlerFunc {
	return s.marketMovesAuth(func(w http.ResponseWriter, r *http.Request, actor string) {
		if !requirePost(w, r) {
			return
		}
		var in MarketMoveInput
		if err := decodeStrict(w, r, &in); err != nil {
			writeMarketMoveError(w, err)
			return
		}
		res, err := s.PublishMarketMove(r.Context(), actor, in)
		if err != nil {
			writeMarketMoveError(w, err)
			return
		}
		status := http.StatusOK
		if res.Outcome == "created" {
			status = http.StatusCreated
		}
		writeMarketMoveResult(w, status, res)
	})
}

// MarketMovesRetractRequest is the body of POST /v1/market-moves/retract.
type MarketMovesRetractRequest struct {
	MoveKey string `json:"move_key"`
	Reason  string `json:"reason,omitempty"`
}

// MarketMovesRetractHandler serves POST /v1/market-moves/retract.
func (s *ShortsServer) MarketMovesRetractHandler() http.HandlerFunc {
	return s.marketMovesAuth(func(w http.ResponseWriter, r *http.Request, actor string) {
		if !requirePost(w, r) {
			return
		}
		var in MarketMovesRetractRequest
		if err := decodeStrict(w, r, &in); err != nil {
			writeMarketMoveError(w, err)
			return
		}
		res, err := s.RetractMarketMove(r.Context(), actor, in.MoveKey, in.Reason)
		if err != nil {
			writeMarketMoveError(w, err)
			return
		}
		writeMarketMoveResult(w, http.StatusOK, res)
	})
}

func requirePost(w http.ResponseWriter, r *http.Request) bool {
	if r.Method == http.MethodPost {
		return true
	}
	w.Header().Set("Allow", "POST")
	writeMarketMoveError(w, &MarketMoveError{Status: http.StatusMethodNotAllowed, Code: "method_not_allowed",
		Message: "use POST with a JSON body; the moves are read through MarketService/ListMarketMoves"})
	return false
}

// decodeStrict decodes one JSON object, refusing unknown fields and trailing data.
func decodeStrict(w http.ResponseWriter, r *http.Request, dst any) error {
	if ct := r.Header.Get("Content-Type"); ct != "" && !strings.HasPrefix(strings.ToLower(ct), "application/json") {
		return &MarketMoveError{Status: http.StatusUnsupportedMediaType, Code: "unsupported_media_type", Message: "send Content-Type: application/json"}
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, marketMovesMaxBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return &MarketMoveError{Status: http.StatusRequestEntityTooLarge, Code: "too_large", Message: fmt.Sprintf("the body is over %d bytes", marketMovesMaxBody)}
		}
		return &MarketMoveError{Status: http.StatusBadRequest, Code: "bad_json", Message: "the body is not the JSON object this route takes: " + err.Error()}
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return &MarketMoveError{Status: http.StatusBadRequest, Code: "bad_json", Message: "send one JSON object, with nothing after it"}
	}
	return nil
}

func writeMarketMoveError(w http.ResponseWriter, err error) {
	var me *MarketMoveError
	if !errors.As(err, &me) {
		me = marketMovesUnavailable()
	}
	if me.Retryable {
		w.Header().Set("Retry-After", "5")
	}
	writeMarketMovesJSON(w, me.Status, me)
}

// marketMoveResponse is a successful answer. move is the public shape the
// read rpc serves, in the proto's field names.
type marketMoveResponse struct {
	Outcome string          `json:"outcome"`
	Status  string          `json:"status"`
	URL     string          `json:"url"`
	Move    json.RawMessage `json:"move"`
}

func writeMarketMoveResult(w http.ResponseWriter, status int, res *MarketMoveResult) {
	move, err := protojson.MarshalOptions{UseProtoNames: true, EmitUnpopulated: true}.Marshal(res.Move)
	if err != nil {
		writeMarketMoveError(w, marketMovesUnavailable())
		return
	}
	writeMarketMovesJSON(w, status, marketMoveResponse{Outcome: res.Outcome, Status: res.Status, URL: res.URL, Move: move})
}

func writeMarketMovesJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
