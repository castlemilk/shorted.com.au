package health

import (
	"fmt"
	"net/http"
)

const (
	alivePath = "/healthz"
	readyPath = "/readyz"
	//versionPath = "/version"
)

type ReadyProvider interface {
	IsReady() bool
}

type ReadySetter interface {
	SetReady(bool)
}

type AliveProvider interface {
	IsAlive() bool
}

type AliveSetter interface {
	SetAlive(bool)
}

type readiness bool

func (r *readiness) IsReady() bool   { return bool(*r) }
func (r *readiness) SetReady(b bool) { *r = readiness(b) }

type liveness bool

func (l *liveness) IsAlive() bool   { return bool(*l) }
func (l *liveness) SetAlive(b bool) { *l = liveness(b) }

// State of services "health"
type State struct {
	ReadyProvider
	AliveProvider
}

func NewState() (*State, error) {
	return &State{ReadyProvider: new(readiness), AliveProvider: new(liveness)}, nil
}

func (s *State) SetReady(ready bool) {
	if r, ok := s.ReadyProvider.(ReadySetter); ok {
		r.SetReady(ready)
	}
}

func (s *State) SetAlive(alive bool) {
	if r, ok := s.AliveProvider.(AliveSetter); ok {
		r.SetAlive(alive)
	}
}

type HTTPServer struct {
	*State
	mux *http.ServeMux
}

func NewHTTPServer() (*HTTPServer, error) {
	state, err := NewState()
	if err != nil {
		return nil, err
	}

	h := &HTTPServer{State: state, mux: http.NewServeMux()}
	h.RegisterWith(h.mux)
	return h, nil
}

type Router interface {
	Handle(path string, h http.Handler)
}

func (h *HTTPServer) RegisterWith(r Router) {
	r.Handle(alivePath, requireGet(h.HandleAlive))
	r.Handle(readyPath, requireGet(h.HandleReady))
}

func (h *HTTPServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mux.ServeHTTP(w, r)
}

func (h *HTTPServer) HandleAlive(w http.ResponseWriter, r *http.Request) {
	if !h.State.IsAlive() {
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprintf(w, "%d service unavailable\n", http.StatusServiceUnavailable)
		return
	}
	fmt.Fprintf(w, "%d ok\n", http.StatusOK)
}

func (h *HTTPServer) HandleReady(w http.ResponseWriter, r *http.Request) {
	if !h.State.IsReady() {
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprintf(w, "%d service unavailable\n", http.StatusServiceUnavailable)
		return
	}
	fmt.Fprintf(w, "%d ok\n", http.StatusOK)
}

func requireGet(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			msg := fmt.Sprintf("%d method not allowed, use GET", http.StatusMethodNotAllowed)
			http.Error(w, msg, http.StatusMethodNotAllowed)
			return
		}
		next(w, r)
	})

}
