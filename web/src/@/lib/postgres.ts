import pg from "pg";

const { Pool } = pg;

type PgPool = InstanceType<typeof Pool>;

let pool: PgPool | null = null;

export function isPostgresConfigured() {
  return Boolean(getPostgresConnectionString());
}

export function getPostgresPool(): PgPool {
  const connectionString = getPostgresConnectionString();

  if (!connectionString) {
    throw new Error("DATABASE_URL or POSTGRES_URL is required for Postgres access");
  }

  if (!pool) {
    pool = new Pool({
      connectionString,
      max: parsePositiveInt(process.env.POSTGRES_POOL_MAX, 5),
      idleTimeoutMillis: parsePositiveInt(
        process.env.POSTGRES_IDLE_TIMEOUT_MS,
        30_000,
      ),
      connectionTimeoutMillis: parsePositiveInt(
        process.env.POSTGRES_CONNECTION_TIMEOUT_MS,
        5_000,
      ),
    });
  }

  return pool;
}

function getPostgresConnectionString() {
  return process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "";
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
