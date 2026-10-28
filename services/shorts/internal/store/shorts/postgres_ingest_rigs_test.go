package shorts

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

// The allowlist's SQL, run against a real Postgres. Only the table the statements
// touch is created; the column set is the one migration 000150 defines.
func ingestRigsTestStore(t *testing.T) *postgresStore {
	t.Helper()
	ctx := context.Background()
	container, err := postgres.Run(ctx, "postgres:14-alpine",
		postgres.WithDatabase("shorts_test"),
		postgres.WithUsername("test_user"),
		postgres.WithPassword("test_password"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).WithStartupTimeout(60*time.Second)),
	)
	checkDockerError(t, err)
	require.NoError(t, err)
	t.Cleanup(func() { _ = container.Terminate(context.Background()) })

	dsn, err := container.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)
	pool, err := pgxpool.New(ctx, dsn)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	_, err = pool.Exec(ctx, `CREATE TABLE housing_ingest_rigs (
		subject TEXT PRIMARY KEY,
		enabled BOOLEAN NOT NULL DEFAULT false,
		created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
		note TEXT)`)
	require.NoError(t, err)
	return &postgresStore{db: pool}
}

func TestIngestRigEnableCreatesThenIsIdempotent(t *testing.T) {
	s := ingestRigsTestStore(t)
	ctx := context.Background()
	note := "first"

	wasEnabled, err := s.EnableIngestRig(ctx, "subj-1", &note)
	require.NoError(t, err)
	require.False(t, wasEnabled, "a new row was not enabled before")

	present, enabled, err := s.IngestRigState(ctx, "subj-1")
	require.NoError(t, err)
	require.True(t, present)
	require.True(t, enabled)

	wasEnabled, err = s.EnableIngestRig(ctx, "subj-1", nil)
	require.NoError(t, err)
	require.True(t, wasEnabled, "the repeat reports the row was already enabled")

	var gotNote *string
	require.NoError(t, s.db.QueryRow(ctx, `SELECT note FROM housing_ingest_rigs WHERE subject='subj-1'`).Scan(&gotNote))
	require.NotNil(t, gotNote, "a nil note keeps the existing one")
	require.Equal(t, "first", *gotNote)
}

func TestIngestRigDisableNeverCreatesARow(t *testing.T) {
	s := ingestRigsTestStore(t)
	ctx := context.Background()

	outcome, err := s.DisableIngestRig(ctx, "ghost")
	require.NoError(t, err)
	require.Equal(t, IngestRigNotPresent, outcome)
	present, _, err := s.IngestRigState(ctx, "ghost")
	require.NoError(t, err)
	require.False(t, present, "disable must not create a row")
}

func TestIngestRigDisableReportsWhatItChanged(t *testing.T) {
	s := ingestRigsTestStore(t)
	ctx := context.Background()
	_, err := s.EnableIngestRig(ctx, "subj-2", nil)
	require.NoError(t, err)

	outcome, err := s.DisableIngestRig(ctx, "subj-2")
	require.NoError(t, err)
	require.Equal(t, IngestRigDisabled, outcome)
	_, enabled, err := s.IngestRigState(ctx, "subj-2")
	require.NoError(t, err)
	require.False(t, enabled)

	outcome, err = s.DisableIngestRig(ctx, "subj-2")
	require.NoError(t, err)
	require.Equal(t, IngestRigUnchanged, outcome)
}

func TestIngestRigListIsClosedAndOmitsTheNote(t *testing.T) {
	s := ingestRigsTestStore(t)
	ctx := context.Background()
	note := "secret-looking free text"
	_, err := s.EnableIngestRig(ctx, "subj-3", &note)
	require.NoError(t, err)

	rigs, err := s.ListIngestRigs(ctx)
	require.NoError(t, err)
	require.Len(t, rigs, 1)
	require.Equal(t, "subj-3", rigs[0].Subject)
	require.True(t, rigs[0].Enabled)
	require.False(t, rigs[0].CreatedAt.IsZero())
}

func TestIngestRigStateTreatsAMissingRowAsNotEnabled(t *testing.T) {
	s := ingestRigsTestStore(t)
	present, enabled, err := s.IngestRigState(context.Background(), "nobody")
	require.NoError(t, err)
	require.False(t, present)
	require.False(t, enabled)
}
