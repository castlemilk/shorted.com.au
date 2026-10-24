package shorts

import (
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// A password with URL-special characters must reach pgx unchanged. Before the
// net/url builder, the '@' in this password ended the userinfo early.
func TestPostgresConnStringKeepsSpecialCharacterPassword(t *testing.T) {
	const pass = `p@ss/w:rd%41 "x"`
	cfg, err := pgxpool.ParseConfig(postgresConnString("app_user", pass, "db.example.com:5432", "shorts"))
	if err != nil {
		t.Fatalf("ParseConfig: %v", err)
	}
	if cfg.ConnConfig.Password != pass {
		t.Fatalf("password = %q, want %q", cfg.ConnConfig.Password, pass)
	}
	if cfg.ConnConfig.User != "app_user" {
		t.Fatalf("user = %q", cfg.ConnConfig.User)
	}
	if cfg.ConnConfig.Host != "db.example.com" || cfg.ConnConfig.Port != 5432 {
		t.Fatalf("host = %q port = %d", cfg.ConnConfig.Host, cfg.ConnConfig.Port)
	}
	if cfg.ConnConfig.Database != "shorts" {
		t.Fatalf("database = %q", cfg.ConnConfig.Database)
	}
}
