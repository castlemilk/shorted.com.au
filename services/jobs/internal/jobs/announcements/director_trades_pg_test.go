package announcements

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readDirectorTradesMigration(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "migrations", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// storeDirectorTrades against a real Postgres: a steady-state run stores
// nothing, new trades are stored once, and one bad row does not cost its
// neighbours.
func TestStoreDirectorTradesAgainstPostgres(t *testing.T) {
	pool := dividendTestDB(t)
	ctx := context.Background()
	dividendTestExec(t, pool, readDirectorTradesMigration(t, "000024_add_director_trades.up.sql"), readDirectorTradesMigration(t, "000050_director_trades_dedup.up.sql"))

	first := []*DirectorTradeRecord{
		trade("BHP", "J Smith", "2025-01-02", "buy", "https://asx/1.pdf"),
		trade("BHP", "O'Brien", "2025-01-03", "sell", "https://asx/2.pdf"),
		trade("BHP", "J Smith", "2025-01-02", "buy", "https://asx/1.pdf"), // repeat
	}
	stored, err := storeDirectorTrades(ctx, pool, first, true)
	if err != nil || stored != 2 {
		t.Fatalf("first run: stored=%d err=%v, want 2", stored, err)
	}

	// The re-crawl hands the same trades back, plus one new one and, in the
	// same chunk, one the table rejects (trade_type is VARCHAR(20)): the chunk
	// fails, and the row-by-row retry still stores the good one.
	again := append(first[:2:2],
		trade("BHP", "A Jones", "2025-01-04", "buy", ""),
		trade("BHP", "X", "2025-01-05", strings.Repeat("x", 25), "u"),
	)
	stored, err = storeDirectorTrades(ctx, pool, again, true)
	if err != nil || stored != 1 {
		t.Fatalf("second run: stored=%d err=%v, want only the new trade", stored, err)
	}

	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM director_trades`).Scan(&n); err != nil || n != 3 {
		t.Fatalf("director_trades holds %d rows (%v), want 3", n, err)
	}
	var name string
	if err := pool.QueryRow(ctx, `SELECT director_name FROM director_trades WHERE trade_date = '2025-01-03'`).Scan(&name); err != nil || name != "O'Brien" {
		t.Fatalf("quoted name stored as %q (%v)", name, err)
	}
	if stored, err := storeDirectorTrades(ctx, pool, again[:3], true); err != nil || stored != 0 {
		t.Fatalf("steady state: stored=%d err=%v, want 0", stored, err)
	}
}
