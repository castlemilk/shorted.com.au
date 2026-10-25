package main

import (
	"testing"
	"time"
)

func TestFlaggrConfigDefaults(t *testing.T) {
	t.Setenv("ENVIRONMENT", "production")
	t.Setenv("FLAGGR_ENVIRONMENT", "")
	t.Setenv("CHAT_MODEL_FLAG_TIMEOUT", "")
	t.Setenv("CHAT_MODEL_FLAG_TTL", "")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}
	if cfg.FlaggrEnvironment != "production" {
		t.Fatalf("FlaggrEnvironment = %q, want production in a production service", cfg.FlaggrEnvironment)
	}
	if cfg.ChatModelFlagTimeout != 200*time.Millisecond || cfg.ChatModelFlagTTL != 30*time.Second {
		t.Fatalf("timeout = %s, ttl = %s; want 200ms and 30s", cfg.ChatModelFlagTimeout, cfg.ChatModelFlagTTL)
	}
}

func TestFlaggrEnvironmentFollowsTheServiceEnvironment(t *testing.T) {
	t.Setenv("ENVIRONMENT", "development")
	t.Setenv("FLAGGR_ENVIRONMENT", "")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}
	if cfg.FlaggrEnvironment != "development" {
		t.Fatalf("FlaggrEnvironment = %q, want development outside production", cfg.FlaggrEnvironment)
	}
}

func TestBadFlaggrDurationNeverStopsStartup(t *testing.T) {
	t.Setenv("CHAT_MODEL_FLAG_TIMEOUT", "soon")
	t.Setenv("CHAT_MODEL_FLAG_TTL", "-5s")
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() error = %v, want startup to go on with the defaults", err)
	}
	if cfg.ChatModelFlagTimeout != 200*time.Millisecond || cfg.ChatModelFlagTTL != 30*time.Second {
		t.Fatalf("timeout = %s, ttl = %s; want the defaults after bad values", cfg.ChatModelFlagTimeout, cfg.ChatModelFlagTTL)
	}
}
