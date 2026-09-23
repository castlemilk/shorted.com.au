#!/usr/bin/env bash
#
# prod-psql.sh — psql against production, with every guard SET over the
# connection, scoped to one transaction, and checked there before the work.
#
#   PGURL=<dsn> scripts/prod-psql.sh read-only                     interactive read-only shell
#   PGURL=<dsn> scripts/prod-psql.sh read-only [-At] -c SQL|-f FILE  one read-only probe
#   PGURL=<dsn> scripts/prod-psql.sh apply FILE                    one migration, statement_timeout=0
#   PGURL=<dsn> scripts/prod-psql.sh refresh FUNCTION              SELECT FUNCTION(), statement_timeout=0
#
# The Taskfile's db:prod:* tasks are the front door: they supply the session
# pooler DSN and require CONFIRM=prod for the writers. This script owns the part
# the tasks cannot: whether the guard is actually in effect.
#
# WHY IN-SESSION. Measured 2026-09-23: Supabase's pooler (Supavisor) drops libpq
# startup options on BOTH 5432 and 6543.
#   PGOPTIONS='-c default_transaction_read_only=on' psql … -c 'SHOW default_transaction_read_only'
# prints `off`, and `-c statement_timeout=0` leaves the role's 2-minute default in
# place. (pgx sends PGOPTIONS as the same startup option, so a Go job gets no
# further.) So every guard this repo expressed as PGOPTIONS did nothing:
#   * the "forced read-only" prod shell could write;
#   * db:prod:apply ran DDL under a 2-minute limit;
#   * db:prod:refresh ran refresh_housing_materialized_views() under that same
#     limit. That function catches query_canceled per view and RAISEs a WARNING,
#     so a view that hit the limit was skipped and the call still returned
#     success.
# Postgres executes a SET sent over the connection itself, so no pooler can
# drop it.
#
# WHY TRANSACTION-SCOPED. A session-level SET outlives your client if the pooler
# hands the same backend to someone else without resetting it. Whether
# Supavisor's session pooler resets session state is UNVERIFIED, and a
# read-only default left on a backend would fail the next client's writes. So
# every guard here is SET LOCAL inside one transaction, which ends with the
# transaction on any pooler:
#   * a probe is one `-c` string: BEGIN READ ONLY; SET LOCAL …; check; SQL; ROLLBACK
#   * the interactive shell is one READ ONLY transaction (prod-psql-read-only.psqlrc)
#   * apply and refresh run under `psql --single-transaction` with
#     SET LOCAL statement_timeout = 0 first
# The one exception is a migration Postgres refuses to run inside a transaction
# block (CREATE INDEX CONCURRENTLY, VACUUM, …) or one that manages its own
# transactions; prod-psql-classify.mjs detects those. Only then does apply fall
# back to a SESSION `SET statement_timeout = 0`, prints a warning, and sends an
# explicit RESET ALL before it exits.
#
# The transaction pooler (6543) is refused outright. Nothing here needs it, and
# DDL or a REFRESH there is killed mid-flight.
#
# The DSN comes from $PGURL and never from an argument, because go-task echoes
# commands after interpolation and would print the credential.
set -euo pipefail

die() {
	echo "prod-psql: $*" >&2
	exit 2
}

warn() {
	echo "prod-psql: WARNING: $*" >&2
}

usage() {
	cat >&2 <<'EOF'
usage: PGURL=<dsn> prod-psql.sh read-only [-A|-t|-x|-q|--csv|-F SEP|-P OPT ...] [-c SQL | -f FILE ...]
       PGURL=<dsn> prod-psql.sh apply FILE
       PGURL=<dsn> prod-psql.sh refresh FUNCTION
EOF
	exit 2
}

mode="${1:-}"
[[ -n "$mode" ]] || usage
shift

[[ -n "${PGURL:-}" ]] || die "PGURL is not set (the DSN rides in the environment, never in argv)"
case "$PGURL" in
*:6543/* | *:6543 | *:6543\?* | *port=6543*)
	die "refusing the transaction pooler (6543). Use the session pooler (5432)."
	;;
esac
[[ "${PGPORT:-}" != 6543 ]] || die "refusing the transaction pooler (PGPORT=6543). Use the session pooler (5432)."

# `--single-transaction` wraps EVERY -c and -f only from psql 15; before that
# the -c guards and the -f file ran outside the one transaction.
psql_major="$(psql --version | sed -E 's/^[^0-9]*([0-9]+).*/\1/')"
[[ "$psql_major" =~ ^[0-9]+$ ]] && ((psql_major >= 15)) ||
	die "psql 15 or newer is required (found: $(psql --version))"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
classifier="$script_dir/prod-psql-classify.mjs"

# The bound on read-only work. It is interpolated into SQL, so only a plain
# duration gets through.
read_timeout="${PROD_PSQL_READ_TIMEOUT:-60s}"
[[ "$read_timeout" =~ ^[1-9][0-9]*(ms|s|min)$ ]] || die "PROD_PSQL_READ_TIMEOUT must look like 60s, 500ms or 5min"

# Prints the settings the work will actually run with, as a NOTICE (stderr, so
# a probe's stdout stays clean), then refuses to continue if the guard is not
# in effect. Under ON_ERROR_STOP the RAISE EXCEPTION ends psql before the work.
guard() {
	local want_read_only="$1" want_timeout="$2"
	cat <<EOF
DO \$guard\$
BEGIN
  RAISE NOTICE 'prod-psql: role=% transaction_read_only=% default_transaction_read_only=% statement_timeout=%',
    current_user,
    current_setting('transaction_read_only'),
    current_setting('default_transaction_read_only'),
    current_setting('statement_timeout');
  IF current_setting('transaction_read_only') <> '$want_read_only' THEN
    RAISE EXCEPTION 'prod-psql: guard not in effect: transaction_read_only is %, want $want_read_only',
      current_setting('transaction_read_only');
  END IF;
  IF current_setting('statement_timeout')::interval <> '$want_timeout'::interval THEN
    RAISE EXCEPTION 'prod-psql: guard not in effect: statement_timeout is %, want $want_timeout',
      current_setting('statement_timeout');
  END IF;
END
\$guard\$
EOF
}

# -X: never read the operator's ~/.psqlrc. An AUTOCOMMIT off or a \set in it
# changes what a migration does, and nobody reviewing the command can see it.
psql_base=(psql "$PGURL" -X -v ON_ERROR_STOP=1)

case "$mode" in
read-only)
	if (($# == 0)); then
		[[ -t 0 ]] || die "no -c/-f given and stdin is not a terminal; pass the probe with -c SQL"
		# Interactive: the rc file opens ONE READ ONLY transaction for the whole
		# shell, checks it, and terminates psql if the check fails.
		PSQLRC="$script_dir/prod-psql-read-only.psqlrc" exec psql "$PGURL" -v ON_ERROR_STOP=1 \
			-v prod_timeout="$read_timeout"
	fi

	# Scripted probe. Output flags pass through; the SQL is gathered into ONE
	# -c string so the guard, the probe and the ROLLBACK are one transaction by
	# construction, whatever the pooler does between separate -c flags.
	flags=()
	sql=""
	while (($# > 0)); do
		case "$1" in
		-c)
			(($# >= 2)) || usage
			sql+="$2"$'\n;\n'
			shift 2
			;;
		-f)
			(($# >= 2)) || usage
			[[ -f "$2" ]] || die "no such file: $2"
			sql+="$(cat "$2")"$'\n;\n'
			shift 2
			;;
		-F | -R | -P)
			(($# >= 2)) || usage
			flags+=("$1" "$2")
			shift 2
			;;
		--csv | --no-align | --tuples-only | --expanded | --quiet)
			flags+=("$1")
			shift
			;;
		-[AtxqH]*)
			[[ "$1" =~ ^-[AtxqH]+$ ]] || die "unsupported psql option: $1"
			flags+=("$1")
			shift
			;;
		*)
			die "unsupported argument: $1 (a probe takes -c SQL / -f FILE and output-format flags only)"
			;;
		esac
	done
	[[ -n "$sql" ]] || usage

	# A COMMIT inside the probe would end the READ ONLY transaction and let the
	# rest of the string run read-write.
	verdict="$(printf '%s' "$sql" | node "$classifier" --probe -)" ||
		die "refusing this probe: ${verdict#refuse }"

	# ROLLBACK, not COMMIT: nothing a probe does is kept, even in a world where
	# the guard had somehow not held. SET LOCAL default_transaction_read_only is
	# not what enforces anything (BEGIN READ ONLY does); it makes
	# `SHOW default_transaction_read_only` inside the probe read `on`, which is
	# the cheapest proof that in-session SETs reach the backend through the pooler.
	exec "${psql_base[@]}" -q ${flags[@]+"${flags[@]}"} -c "BEGIN READ ONLY;
SET LOCAL default_transaction_read_only = on;
SET LOCAL statement_timeout = '$read_timeout';
$(guard on "$read_timeout");
${sql}ROLLBACK;"
	;;

apply)
	file="${1:-}"
	[[ -n "$file" ]] || usage
	[[ -f "$file" ]] || die "no such file: $file"

	set +e
	verdict="$(node "$classifier" "$file")"
	rc=$?
	set -e
	case "$rc" in
	0)
		# One transaction: BEGIN, SET LOCAL, check, the file, RESET ALL, COMMIT.
		# RESET ALL covers a plain SET inside the migration itself, which would
		# otherwise become the backend's session value at COMMIT. A file wrapped
		# in its own BEGIN … COMMIT still fits: its BEGIN only warns and its
		# COMMIT is the last statement.
		exec "${psql_base[@]}" --single-transaction \
			-c "SET LOCAL statement_timeout = 0" -c "$(guard off 0)" \
			-f "$file" \
			-c "RESET ALL"
		;;
	3)
		warn "${verdict#session }."
		warn "Falling back to a SESSION-level SET statement_timeout = 0, undone by RESET ALL before exit."
		set +e
		"${psql_base[@]}" \
			-c "SET statement_timeout = 0" -c "$(guard off 0)" \
			-f "$file" \
			-c "RESET ALL"
		rc=$?
		set -e
		if ((rc != 0)); then
			warn "psql stopped (exit $rc) before RESET ALL ran. statement_timeout = 0 stays on that server"
			warn "connection until it closes, and whether Supavisor resets it for the next client is unverified."
		fi
		exit "$rc"
		;;
	*)
		die "refusing $file: ${verdict#refuse }"
		;;
	esac
	;;

refresh)
	fn="${1:-}"
	[[ -n "$fn" ]] || usage
	# Interpolated into SQL, so only a bare identifier gets through.
	[[ "$fn" =~ ^[a-z_][a-z0-9_]*$ ]] || die "not a function name: $fn"

	# SET LOCAL before the call, not inside the function. A function-level
	# `SET statement_timeout` (000107) cannot disarm the timer Postgres already
	# started for the calling statement.
	#
	# The refresh functions catch a failed view and RAISE WARNING 'Skipping mv_…'
	# instead of failing, so psql exits 0 with a view left stale. Treat that line
	# as the failure it is.
	errlog="$(mktemp "${TMPDIR:-/tmp}/prod-psql-refresh.XXXXXX")"
	trap 'rm -f "$errlog"' EXIT
	# stdout goes straight out via fd 3; stderr is copied to $errlog on its way
	# to the terminal. Under pipefail the pipeline fails with psql's status.
	exec 3>&1
	set +e
	"${psql_base[@]}" --single-transaction \
		-c "SET LOCAL statement_timeout = 0" -c "$(guard off 0)" \
		-c "SELECT $fn()" 2>&1 1>&3 | tee "$errlog" >&2
	rc=$?
	set -e
	exec 3>&-
	((rc == 0)) || exit "$rc"
	if skipped="$(grep -c 'WARNING: *Skipping ' "$errlog")"; then
		echo "prod-psql: $fn() skipped $skipped view(s) (see the WARNINGs above); they are still stale." >&2
		exit 1
	fi
	;;

*)
	usage
	;;
esac
