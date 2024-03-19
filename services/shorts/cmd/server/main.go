package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/castlemilk/shorted.com.au/services/pkg/health"
	"github.com/castlemilk/shorted.com.au/services/pkg/log"
	"github.com/castlemilk/shorted.com.au/services/shorts/cmd/server/config"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts"
	"golang.org/x/sync/errgroup"
)

func registerOps(config *config.Config, mux *http.ServeMux, hs *health.HTTPServer) {
	hs.RegisterWith(mux)
	mux.HandleFunc("/config.json", config.ServeAsJSON)
	mux.HandleFunc("/config.yaml", config.ServeAsYAML)
}

func main() {
	ctx := context.Background()
	logger := log.NewLogger()
	logger.SetLevel("debug")
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("failed to load configuration: %v", err)
	}

	healthServer, err := health.NewHTTPServer()
	if err != nil {
		log.Errorf("error setting up health server: %v", err)
		os.Exit(1)
	}
	opsMux := http.NewServeMux()
	opsAddr := fmt.Sprintf(":%d", cfg.OpsSpec.Port)
	opsServer := &http.Server{
		Addr:    opsAddr,
		Handler: opsMux,
	}
	registerOps(cfg, opsMux, healthServer)
	s, err := shorts.New(ctx, cfg.AppSpec)
	g, gCtx := errgroup.WithContext(ctx)
	healthServer.SetAlive(true)
	g.Go(func() error {
		log.Infof("starting ops server at %s", opsAddr)
		return opsServer.ListenAndServe()
	})
	serverAddr := fmt.Sprintf(":%d", cfg.AppSpec.Port)
	g.Go(func() error {
		log.Infof("starting server server at %s", serverAddr)
		return s.Serve(ctx, logger, serverAddr)
	})
	g.Go(signalListener(gCtx))
	//TODO: do some work normally before setting ready
	healthServer.SetReady(true)

	log.Errorf("agent terminated with error: %v", g.Wait())
}

func signalListener(ctx context.Context) func() error {
	return func() error {
		signalC := make(chan os.Signal, 1)
		defer close(signalC)
		signal.Notify(signalC, syscall.SIGTERM)

		select {
		// app recives sigterm
		case <-signalC:
			return fmt.Errorf("recieved SIGTERM")
		// outer context finished
		case <-ctx.Done():
			return nil
		}
	}
}
