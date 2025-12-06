package integration

import (
	"context"
	"database/sql"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestSyncStatusTable tests the sync_status table schema
func TestSyncStatusTable(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	ctx := context.Background()
	db := setupTestDB(t)
	defer db.Close()

	// Test table exists
	t.Run("table exists", func(t *testing.T) {
		var exists bool
		err := db.QueryRowContext(ctx, `
			SELECT EXISTS (
				SELECT FROM information_schema.tables 
				WHERE table_name = 'sync_status'
			)
		`).Scan(&exists)
		require.NoError(t, err)
		assert.True(t, exists, "sync_status table should exist")
	})

	// Test required columns exist
	t.Run("has required columns", func(t *testing.T) {
		requiredColumns := []string{
			"run_id", "status", "started_at", "completed_at",
			"shorts_records_updated", "prices_records_updated",
			"total_duration_seconds", "error_message",
		}

		for _, col := range requiredColumns {
			var exists bool
			err := db.QueryRowContext(ctx, `
				SELECT EXISTS (
					SELECT FROM information_schema.columns 
					WHERE table_name = 'sync_status' AND column_name = $1
				)
			`, col).Scan(&exists)
			require.NoError(t, err)
			assert.True(t, exists, fmt.Sprintf("Column %s should exist", col))
		}
	})
}

// TestSyncStatusInsert tests inserting sync status records
func TestSyncStatusInsert(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	ctx := context.Background()
	db := setupTestDB(t)
	defer db.Close()

	runID := uuid.New().String()

	// Insert a running record
	_, err := db.ExecContext(ctx, `
		INSERT INTO sync_status (run_id, status, environment, hostname)
		VALUES ($1, 'running', 'test', 'test-host')
	`, runID)
	require.NoError(t, err)

	// Verify record
	var status, environment, hostname string
	err = db.QueryRowContext(ctx, `
		SELECT status, environment, hostname FROM sync_status WHERE run_id = $1
	`, runID).Scan(&status, &environment, &hostname)
	require.NoError(t, err)
	assert.Equal(t, "running", status)
	assert.Equal(t, "test", environment)
	assert.Equal(t, "test-host", hostname)

	// Cleanup
	_, err = db.ExecContext(ctx, "DELETE FROM sync_status WHERE run_id = $1", runID)
	require.NoError(t, err)
}

// TestSyncStatusComplete tests completing a sync run
func TestSyncStatusComplete(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	ctx := context.Background()
	db := setupTestDB(t)
	defer db.Close()

	runID := uuid.New().String()

	// Insert a running record
	_, err := db.ExecContext(ctx, `
		INSERT INTO sync_status (run_id, status, environment, hostname)
		VALUES ($1, 'running', 'test', 'test-host')
	`, runID)
	require.NoError(t, err)

	// Update to completed with metrics
	_, err = db.ExecContext(ctx, `
		UPDATE sync_status SET
			status = 'completed',
			completed_at = CURRENT_TIMESTAMP,
			shorts_records_updated = $2,
			prices_records_updated = $3,
			metrics_records_updated = $4,
			total_duration_seconds = $5
		WHERE run_id = $1
	`, runID, 100, 200, 50, 30.5)
	require.NoError(t, err)

	// Verify
	var status string
	var shortsUpdated, pricesUpdated, metricsUpdated sql.NullInt32
	var duration sql.NullFloat64
	err = db.QueryRowContext(ctx, `
		SELECT status, shorts_records_updated, prices_records_updated, 
		       metrics_records_updated, total_duration_seconds
		FROM sync_status WHERE run_id = $1
	`, runID).Scan(&status, &shortsUpdated, &pricesUpdated, &metricsUpdated, &duration)
	require.NoError(t, err)
	assert.Equal(t, "completed", status)
	assert.Equal(t, int32(100), shortsUpdated.Int32)
	assert.Equal(t, int32(200), pricesUpdated.Int32)
	assert.Equal(t, int32(50), metricsUpdated.Int32)
	assert.InDelta(t, 30.5, duration.Float64, 0.01)

	// Cleanup
	_, err = db.ExecContext(ctx, "DELETE FROM sync_status WHERE run_id = $1", runID)
	require.NoError(t, err)
}

// TestSyncStatusFailed tests recording a failed sync run
func TestSyncStatusFailed(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	ctx := context.Background()
	db := setupTestDB(t)
	defer db.Close()

	runID := uuid.New().String()
	errorMessage := "Test error: Connection refused"

	// Insert a running record
	_, err := db.ExecContext(ctx, `
		INSERT INTO sync_status (run_id, status, environment, hostname)
		VALUES ($1, 'running', 'test', 'test-host')
	`, runID)
	require.NoError(t, err)

	// Update to failed with error message
	_, err = db.ExecContext(ctx, `
		UPDATE sync_status SET
			status = 'failed',
			completed_at = CURRENT_TIMESTAMP,
			error_message = $2,
			total_duration_seconds = $3
		WHERE run_id = $1
	`, runID, errorMessage, 5.0)
	require.NoError(t, err)

	// Verify
	var status string
	var errMsg sql.NullString
	err = db.QueryRowContext(ctx, `
		SELECT status, error_message FROM sync_status WHERE run_id = $1
	`, runID).Scan(&status, &errMsg)
	require.NoError(t, err)
	assert.Equal(t, "failed", status)
	assert.True(t, errMsg.Valid)
	assert.Equal(t, errorMessage, errMsg.String)

	// Cleanup
	_, err = db.ExecContext(ctx, "DELETE FROM sync_status WHERE run_id = $1", runID)
	require.NoError(t, err)
}

// TestSyncStatusQuery tests querying sync status history
func TestSyncStatusQuery(t *testing.T) {
	if testing.Short() {
		t.Skip("Skipping integration test in short mode")
	}

	ctx := context.Background()
	db := setupTestDB(t)
	defer db.Close()

	// Insert multiple records
	runIDs := make([]string, 3)
	for i := 0; i < 3; i++ {
		runIDs[i] = uuid.New().String()
		status := "completed"
		if i == 1 {
			status = "failed"
		}
		_, err := db.ExecContext(ctx, `
			INSERT INTO sync_status (run_id, status, environment, hostname,
				shorts_records_updated, prices_records_updated, total_duration_seconds)
			VALUES ($1, $2, 'test', 'test-host', $3, $4, $5)
		`, runIDs[i], status, (i+1)*100, (i+1)*50, float64(i+1)*10.0)
		require.NoError(t, err)
		time.Sleep(10 * time.Millisecond) // Ensure different timestamps
	}

	// Query with limit
	rows, err := db.QueryContext(ctx, `
		SELECT run_id, status, shorts_records_updated, prices_records_updated
		FROM sync_status
		WHERE environment = 'test'
		ORDER BY started_at DESC
		LIMIT 2
	`)
	require.NoError(t, err)
	defer rows.Close()

	count := 0
	for rows.Next() {
		var runID, status string
		var shorts, prices sql.NullInt32
		err := rows.Scan(&runID, &status, &shorts, &prices)
		require.NoError(t, err)
		count++
	}
	assert.Equal(t, 2, count, "Should return 2 records with LIMIT 2")

	// Cleanup
	for _, runID := range runIDs {
		_, err = db.ExecContext(ctx, "DELETE FROM sync_status WHERE run_id = $1", runID)
		require.NoError(t, err)
	}
}

// setupTestDB creates a test database connection
func setupTestDB(t *testing.T) *sql.DB {
	// Use the test container or local database
	dsn := "postgresql://admin:password@localhost:5438/shorts?sslmode=disable"
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Skipf("Could not connect to test database: %v", err)
	}

	// Test connection
	if err := db.Ping(); err != nil {
		t.Skipf("Could not ping test database: %v", err)
	}

	return db
}

